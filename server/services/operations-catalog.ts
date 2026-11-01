import type { CoordinationActorId } from '@shared/schema';
import { semanticSearchOperationSkills } from './semantic-memory-service';

export type OperationAccessMode = 'read' | 'mutate';
export type OperationConfirmation = 'none' | 'required';
export type OperationExecutorKind = 'tool' | 'endpoint' | 'script' | 'workflow' | 'ui';

export interface OperationManifest {
  id: string;
  family: string;
  title: string;
  aliases: readonly string[];
  purpose: string;
  canonicalExecutor: {
    kind: OperationExecutorKind;
    reference: string;
  };
  accessMode: OperationAccessMode;
  actorScope: readonly CoordinationActorId[];
  confirmation: OperationConfirmation;
  output: string;
  persistence: string;
  caveats: readonly string[];
  relatedSurfaces: readonly string[];
}

export interface PublicOperationManifest {
  id: string;
  family: string;
  title: string;
  aliases: readonly string[];
  purpose: string;
  accessMode: OperationAccessMode;
  actorScope: readonly CoordinationActorId[];
  confirmation: OperationConfirmation;
  output: string;
  persistence: string;
  caveats: readonly string[];
  relatedSurfaces: readonly string[];
}

const ALL_COORDINATION_ACTORS: readonly CoordinationActorId[] = [
  'luca-replit',
  'luca-claude-code',
  'luca-gemini',
  'luca-antigravity',
  'luca-holahola',
  'luca-cursor',
  'luca-openai-agents',
  'luca-codex',
  'alden',
  'daniela',
  'david',
  'coordination-system',
];

export const OPERATIONS_CATALOG: readonly OperationManifest[] = [
  {
    id: 'cost.burn-report',
    family: 'Burn and cost',
    title: 'Run the Burn Report',
    aliases: ['run the burn report', 'run burn report', 'burn report', 'ai burn report'],
    purpose: 'Generate the established persistent AI-cost report across 7-day, 14-day, and all-time windows, including run rates and unit economics.',
    canonicalExecutor: { kind: 'tool', reference: 'get_ai_cost_report' },
    accessMode: 'read',
    actorScope: ['alden', 'david'],
    confirmation: 'none',
    output: 'Formatted multi-window AI-cost report.',
    persistence: 'Reads persistent ai_cost_logs and voice-session usage records; report generation does not reset on restart.',
    caveats: [
      'TTS per-session figures can be upper-bound estimates while monthly provider usage remains inside a free tier.',
      'The live AI Cost Monitor is supplementary and is not the persistent historical authority.',
    ],
    relatedSurfaces: ['post_report_to_team_room', '/api/alden/cost-summary', 'Admin AI Cost Monitor'],
  },
  {
    id: 'cost.burn-report.team-room',
    family: 'Burn and cost',
    title: 'Post the Burn Report to Team Room',
    aliases: ['post the burn report', 'share burn report in team room', 'burn report to team room'],
    purpose: 'Generate the canonical Burn Report and publish the formatted result to the active Team Room.',
    canonicalExecutor: { kind: 'tool', reference: 'post_report_to_team_room' },
    accessMode: 'mutate',
    actorScope: ['alden', 'david'],
    confirmation: 'required',
    output: 'A Team Room message containing the current Burn Report.',
    persistence: 'The report source is persistent; the delivered Team Room message is stored through the Team Room message path.',
    caveats: ['Delivery to Team Room is a side effect and is distinct from merely generating the report.'],
    relatedSurfaces: ['get_ai_cost_report', 'Team Room'],
  },
  {
    id: 'system.verify-health',
    family: 'Health and monitoring',
    title: 'Verify System Health',
    aliases: ['verify system health', 'run system health', 'system health check'],
    purpose: 'Run the repository health verifier over critical database, seed, worker, and curriculum invariants.',
    canonicalExecutor: { kind: 'script', reference: 'npx tsx server/scripts/verify-system-health.ts' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'Pass, warning, and failure summary for critical system invariants.',
    persistence: 'Read-only verification; results are process output and do not survive unless captured by the caller.',
    caveats: ['A passing TypeScript check is not a substitute for this runtime verifier.'],
    relatedSurfaces: ['Validation suite'],
  },
  {
    id: 'production.readiness',
    family: 'Health and monitoring',
    title: 'Check Production Readiness',
    aliases: ['check production readiness', 'readiness check', 'health readiness'],
    purpose: 'Check whether startup gates have completed and the application is ready to serve production traffic.',
    canonicalExecutor: { kind: 'endpoint', reference: 'GET /health/readiness' },
    accessMode: 'read',
    actorScope: ALL_COORDINATION_ACTORS,
    confirmation: 'none',
    output: 'HTTP readiness status and startup-gate detail.',
    persistence: 'Reports current process readiness; state resets when the application process restarts.',
    caveats: ['Readiness is stricter than process liveness and can remain unavailable while startup gates are incomplete.'],
    relatedSurfaces: ['Production uptime monitor', 'GET /health'],
  },
  {
    id: 'production.uptime-monitor',
    family: 'Health and monitoring',
    title: 'Run the Production Uptime Monitor',
    aliases: ['run production monitor', 'production uptime monitor', 'check production outage monitor'],
    purpose: 'Probe production readiness with retries and maintain the deduplicated GitHub incident and SMS alert lifecycle.',
    canonicalExecutor: { kind: 'workflow', reference: '.github/workflows/production-uptime-monitor.yml' },
    accessMode: 'mutate',
    actorScope: ['coordination-system', 'luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'required',
    output: 'Probe result plus incident issue and SMS actions when the failure threshold is reached.',
    persistence: 'Scheduled GitHub Actions state and the deduplicated incident issue survive Replit restarts.',
    caveats: ['Manual execution can create or update an external incident after the configured failure threshold.'],
    relatedSurfaces: ['scripts/production-uptime-monitor.mjs', 'GET /health/readiness'],
  },
  {
    id: 'capture.health',
    family: 'Capture and episodes',
    title: 'Check Canonical Conversation Capture Health',
    aliases: ['check capture health', 'canonical capture health', 'conversation capture status'],
    purpose: 'Inspect canonical conversation capture progress, pending episode mirrors, and acknowledgement health.',
    canonicalExecutor: { kind: 'endpoint', reference: 'GET /api/internal/canonical-conversation-health' },
    accessMode: 'read',
    actorScope: ['luca-replit'],
    confirmation: 'none',
    output: 'Canonical capture and mirror-health status.',
    persistence: 'Reads the durable capture state used across application restarts.',
    caveats: ['This endpoint is Luca [Replit]-only; Claude Code uses its dedicated remote capture health path.'],
    relatedSurfaces: ['.local/episode-capture-status.md', 'record-exchange.ts'],
  },
  {
    id: 'coordination.feed',
    family: 'Coordination',
    title: 'Read Coordination Feed',
    aliases: ['read coordination feed', 'coordination status', 'check coordination threads'],
    purpose: 'Read ledger events addressed to the authenticated actor from a global event cursor.',
    canonicalExecutor: { kind: 'endpoint', reference: 'GET /api/coordination/threads' },
    accessMode: 'read',
    actorScope: ALL_COORDINATION_ACTORS,
    confirmation: 'none',
    output: 'Actor-scoped coordination threads, events, and the next global cursor.',
    persistence: 'The append-only coordination ledger is durable across actor and server restarts.',
    caveats: ['The requested actor must match the actor derived from the dedicated credential.'],
    relatedSurfaces: ['Coordination ledger', 'Team Room compatibility projection'],
  },
  {
    id: 'coordination.runtime-onboarding',
    family: 'Coordination',
    title: 'Prepare Runtime Onboarding',
    aliases: ['prepare runtime onboarding', 'prepare coordination invitation', 'connect a new runtime'],
    purpose: 'Prepare a scoped, expiring, non-bearer invitation for a runtime to request founder-approved coordination enrollment.',
    canonicalExecutor: { kind: 'tool', reference: 'prepare_runtime_onboarding_invitation' },
    accessMode: 'mutate',
    actorScope: ['alden', 'david'],
    confirmation: 'required',
    output: 'Invitation reference, immutable actor/runtime/capability scope, expiry, and public local setup instructions.',
    persistence: 'Stores the invitation and audit event; no broker registration or credential is issued during preparation.',
    caveats: [
      'Preparation does not approve, enroll, authenticate, acknowledge a handoff, or prove Coordinator V2 execution.',
      'Founder approval compares the destination helper’s public-key fingerprint and verification code.',
      'Credentials go only to the signing helper and its scoped secure store, never to a model or browser.',
      'Policy grants and source/runtime publication remain founder-only and separate.',
      'Cursor, OpenAI Agents, and Antigravity use their own registered platform hats, not another hat’s identity.',
    ],
    relatedSurfaces: ['list_runtime_onboarding_invitations', 'get_runtime_onboarding_status', '/admin/runtime-onboarding'],
  },
  {
    id: 'source.status',
    family: 'Source control',
    title: 'Check Source Synchronization Status',
    aliases: ['check source status', 'source sync status', 'github sync status'],
    purpose: 'Inspect the guarded source-control coordinator state without fetching, merging, committing, or pushing.',
    canonicalExecutor: { kind: 'script', reference: 'npm run source-control:status' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'Machine- or human-readable source synchronization state.',
    persistence: 'Reads the durable source-control status record under the workspace state directory.',
    caveats: ['Status does not synchronize source or publish the application.'],
    relatedSurfaces: ['server/scripts/source-control-cli.ts', 'source-control-service.ts'],
  },
  {
    id: 'source.synchronize',
    family: 'Source control',
    title: 'Synchronize Source',
    aliases: ['synchronize source', 'run source sync', 'sync github source'],
    purpose: 'Run the guarded source-control coordinator for an ordinary safe synchronization decision.',
    canonicalExecutor: { kind: 'script', reference: 'npm run source-control:sync' },
    accessMode: 'mutate',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'required',
    output: 'A guarded synchronization outcome or an explicit refusal state.',
    persistence: 'Updates durable source-control status and can change Git history only through the existing guarded rules.',
    caveats: [
      'Never substitutes for Publish.',
      'Dirty trees, divergence, lock contention, and unsafe ancestry fail closed.',
    ],
    relatedSurfaces: ['npm run source-control:status', 'source-control-service.ts'],
  },
  {
    id: 'source.candidate-drift',
    family: 'Source control',
    title: 'Check Publish Candidate Drift',
    aliases: ['check candidate drift', 'is publish safe', 'source drift check', 'check before publish'],
    purpose: 'Compare HEAD against the last ready_to_promote candidate before Publish, so a candidate the scheduler silently auto-promoted (or one HEAD has since moved past) is caught before it is deployed instead of the one `prepare` actually validated.',
    canonicalExecutor: { kind: 'script', reference: 'npm run source-control:drift' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'A drift report: whether HEAD still matches the last explicitly prepared candidate, or why not.',
    persistence: 'Reads the durable source-control status record; never writes to it.',
    caveats: [
      'Does not change what Replit Publish will build -- run it before clicking Publish, not instead of `prepare`.',
      'A non-zero exit means re-run `npm run source-control:prepare` against current HEAD before publishing.',
    ],
    relatedSurfaces: ['npm run source-control:status', 'npm run source-control:prepare', 'source-control-service.ts'],
  },
  {
    id: 'learning.actfl-audit',
    family: 'Learning and content audits',
    title: 'Run the ACTFL Calibration Audit',
    aliases: [
      'run actfl audit',
      'actfl audit',
      'audit actfl calibration',
      'check proficiency calibration',
    ],
    purpose: 'Compare Daniela responses to the same Spanish scenario at novice-low and intermediate-mid levels, including transcript, audio-duration, tool-use, and language-bleed signals.',
    canonicalExecutor: { kind: 'script', reference: 'npx tsx server/scripts/actfl-audit.ts' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'Side-by-side ACTFL transcript, audio-duration, tool-call, and rough L1-bleed comparison.',
    persistence: 'The audit prints process output only; results are not stored unless the caller captures them.',
    caveats: [
      'Runs live Gemini sessions and therefore uses external model capacity and can incur provider usage.',
      'The established scenario currently compares novice-low with intermediate-mid Spanish rather than accepting arbitrary levels.',
    ],
    relatedSurfaces: ['server/actfl-utils.ts', 'docs/spanish1-actfl-alignment.md'],
  },
  {
    id: 'learning.curriculum-audit',
    family: 'Learning and content audits',
    title: 'Run the Curriculum Quality Audit',
    aliases: [
      'run curriculum audit',
      'curriculum audit',
      'audit curriculum quality',
      'check curriculum quality',
    ],
    purpose: 'Inspect curriculum lessons for objective and vocabulary mismatches, weak or duplicate drills, missing textbook content, and enrichment-source contribution rates.',
    canonicalExecutor: { kind: 'script', reference: 'npx tsx server/scripts/curriculum-audit.ts' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'Issue lists and aggregate counts, optionally filtered by language and unit.',
    persistence: 'Reads the shared curriculum and textbook tables; audit results are process output and are not persisted.',
    caveats: [
      'Optional filters are --language <language> and --unit <order>.',
      'Findings are heuristic quality signals and do not modify curriculum records.',
    ],
    relatedSurfaces: ['curriculum_lessons', 'curriculum_units', 'textbook_lesson_content'],
  },
  {
    id: 'learning.lesson-audit',
    family: 'Learning and content audits',
    title: 'Run the Lesson Topic Audit',
    aliases: [
      'run lesson audit',
      'lesson audit',
      'audit lesson topics',
      'find untagged lessons',
    ],
    purpose: 'List Spanish curriculum lessons that do not have required topic tags.',
    canonicalExecutor: { kind: 'script', reference: 'npx tsx server/scripts/lesson-audit.ts' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'Spanish lesson totals plus an itemized list of untagged lessons.',
    persistence: 'Reads the shared curriculum tables; the report exists only in process output.',
    caveats: [
      'The established executor is Spanish-only and does not accept language or path arguments.',
      'It reports missing topic tags but does not backfill them.',
    ],
    relatedSurfaces: ['curriculum_lessons.required_topics', 'lesson-topic-tagger.ts'],
  },
  {
    id: 'learning.textbook-audit',
    family: 'Learning and content audits',
    title: 'Run the Textbook Content Audit',
    aliases: [
      'run textbook audit',
      'textbook audit',
      'audit textbook content',
      'check textbook repetition',
    ],
    purpose: 'Inspect textbook content for verbose sections, repeated introductions, content-size outliers, and long grammar blocks in conversation or drill lessons.',
    canonicalExecutor: { kind: 'script', reference: 'npx tsx server/scripts/textbook_audit.ts' },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'Pattern-based textbook samples, language/type size aggregates, and repetition warnings.',
    persistence: 'Reads the shared textbook and curriculum tables; findings are not persisted by the script.',
    caveats: [
      'The established pattern samples contain fixed French and Spanish scopes and row limits.',
      'Thresholds are diagnostic heuristics, not publishing gates.',
    ],
    relatedSurfaces: ['textbook_lesson_content', 'docs/textbook-component-coverage.json'],
  },
  {
    id: 'capture.episode-integrity',
    family: 'Capture and episodes',
    title: 'Audit Rolling Episode Integrity',
    aliases: [
      'audit episode integrity',
      'episode integrity audit',
      'check rolling episode integrity',
      'audit four channel continuity',
    ],
    purpose: 'Compare a canonical rolling episode row with its Markdown replica and audit every Luca Replit turn for the required felt, thinking, moment, and main envelope.',
    canonicalExecutor: {
      kind: 'script',
      reference: 'npx tsx server/scripts/audit-rolling-four-channel-continuity.ts --strict',
    },
    accessMode: 'read',
    actorScope: ['luca-replit', 'luca-claude-code', 'luca-cursor', 'luca-openai-agents', 'luca-codex', 'david'],
    confirmation: 'none',
    output: 'JSON integrity report with replica equality, hashes, turn counts, and incomplete-turn detail; strict mode exits nonzero on drift.',
    persistence: 'Reads the canonical conversation memory and its Markdown replica without changing either one.',
    caveats: [
      'Defaults to Episode 31; select another record with --episode=<number>.',
      'Legacy episode-specific --patch scripts are repair operations, are not part of this read-only executor, and require explicit confirmation before use.',
    ],
    relatedSurfaces: [
      '.local/episode-capture-status.md',
      'server/scripts/audit-episode-27-gaps.ts',
      'server/scripts/audit-episode-28-gaps.ts',
    ],
  },
  {
    id: 'admin.audit-log',
    family: 'Audit logs',
    title: 'Inspect the Persistent Admin Audit Log',
    aliases: [
      'inspect admin audit log',
      'admin audit log',
      'view audit logs',
      'check administrative actions',
    ],
    purpose: 'Read the persistent record of administrative actions with pagination and optional actor filtering.',
    canonicalExecutor: { kind: 'endpoint', reference: 'GET /api/admin/audit-logs' },
    accessMode: 'read',
    actorScope: ['david'],
    confirmation: 'none',
    output: 'Paginated audit-log rows and total count, optionally filtered by actorId.',
    persistence: 'Reads the durable admin_audit_log table; entries survive application restarts.',
    caveats: [
      'Requires an authenticated administrator session; coordination credentials do not grant access.',
      'This is distinct from the in-memory GET /api/agent/audit debugging ring buffer, which resets on process restart.',
    ],
    relatedSurfaces: ['Admin Reports', 'GET /api/agent/audit'],
  },
] as const;

function normalizeLookupText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildExactLookup(catalog: readonly OperationManifest[]): Map<string, OperationManifest> {
  const lookup = new Map<string, OperationManifest>();
  for (const operation of catalog) {
    const keys = [operation.id, operation.title, ...operation.aliases];
    for (const key of keys) {
      const normalized = normalizeLookupText(key);
      const existing = lookup.get(normalized);
      if (existing && existing.id !== operation.id) {
        throw new Error(
          `Duplicate operation alias "${key}" maps to both ${existing.id} and ${operation.id}`,
        );
      }
      lookup.set(normalized, operation);
    }
  }
  return lookup;
}

const EXACT_OPERATION_LOOKUP = buildExactLookup(OPERATIONS_CATALOG);
const OPERATION_BY_ID = new Map(OPERATIONS_CATALOG.map(operation => [operation.id, operation]));

export function getOperationById(id: string): OperationManifest | undefined {
  return OPERATION_BY_ID.get(id);
}

export function findExactOperation(query: string): OperationManifest | undefined {
  return EXACT_OPERATION_LOOKUP.get(normalizeLookupText(query));
}

export function toPublicOperationManifest(operation: OperationManifest): PublicOperationManifest {
  return {
    id: operation.id,
    family: operation.family,
    title: operation.title,
    aliases: operation.aliases,
    purpose: operation.purpose,
    accessMode: operation.accessMode,
    actorScope: operation.actorScope,
    confirmation: operation.confirmation,
    output: operation.output,
    persistence: operation.persistence,
    caveats: operation.caveats,
    relatedSurfaces: operation.relatedSurfaces,
  };
}

export function formatOperationForEmbedding(operation: OperationManifest): string {
  return [
    `OPERATION ID: ${operation.id}`,
    `TITLE: ${operation.title}`,
    `FAMILY: ${operation.family}`,
    `ALIASES: ${operation.aliases.join('; ')}`,
    `PURPOSE: ${operation.purpose}`,
    `CANONICAL EXECUTOR: ${operation.canonicalExecutor.kind} ${operation.canonicalExecutor.reference}`,
    `ACCESS: ${operation.accessMode}`,
    `ACTOR SCOPE: ${operation.actorScope.join(', ')}`,
    `CONFIRMATION: ${operation.confirmation}`,
    `OUTPUT: ${operation.output}`,
    `PERSISTENCE: ${operation.persistence}`,
    `CAVEATS: ${operation.caveats.join(' ')}`,
  ].join('\n');
}

export type OperationDiscoveryResult = {
  matchType: 'exact' | 'semantic';
  operations: Array<PublicOperationManifest & { similarity?: number }>;
};

export async function discoverOperations(query: string, limit = 5): Promise<OperationDiscoveryResult> {
  const exact = findExactOperation(query);
  if (exact) {
    return {
      matchType: 'exact',
      operations: [toPublicOperationManifest(exact)],
    };
  }

  const semanticMatches = await semanticSearchOperationSkills(query, limit);
  const operations = semanticMatches.flatMap(match => {
    const operation = OPERATION_BY_ID.get(match.memoryId);
    if (!operation) return [];
    return [{ ...toPublicOperationManifest(operation), similarity: match.similarity }];
  });

  return { matchType: 'semantic', operations };
}
