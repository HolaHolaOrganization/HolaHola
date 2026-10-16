/**
 * Instance role and default-deny background-task gate.
 *
 * Standard-controls plan efb1e3d1, revision 7, Phase S2.2 (review R4): every
 * HolaHola process runs against the ONE live database, so a second running
 * app (a dev server, a Replit workspace, the future Render dev service) must not
 * silently start production's schedulers, workers, capture, alerts and boot
 * writes a second time.
 *
 * - HOLAHOLA_INSTANCE_ROLE is REQUIRED and must be exactly `production` or
 *   `dev`. A missing or unknown value refuses boot, so a forgotten setting can
 *   never quietly enable (or quietly disable) every worker.
 * - Every background task server/index.ts starts is registered below with the
 *   roles allowed to run it. The default is production-only: `dev` runs
 *   nothing unless a task is explicitly listed for it here, in a reviewed
 *   change. Paused or held work (capture, incident recovery, the worker
 *   implementation) therefore cannot resume merely because a dev server booted.
 * - Production behaviour is unchanged: every registered task is allowed there,
 *   in its existing order and timing.
 *
 * Out of scope for this gate, and stated so nobody assumes otherwise:
 * request-path outbound actions (SMS, calls, email triggered by an HTTP request)
 * are not blocked here; that is a separate change.
 */

export const INSTANCE_ROLES = ['production', 'dev'] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

export const INSTANCE_ROLE_ENV = 'HOLAHOLA_INSTANCE_ROLE';

export class InstanceRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceRoleError';
  }
}

export function resolveInstanceRole(env: NodeJS.ProcessEnv = process.env): InstanceRole {
  const raw = env[INSTANCE_ROLE_ENV];
  if (raw === undefined || raw === '') {
    throw new InstanceRoleError(
      `${INSTANCE_ROLE_ENV} is required (one of: ${INSTANCE_ROLES.join(', ')}). ` +
      'Refusing to boot: without it this process cannot know whether it may start production background work.',
    );
  }
  if (!(INSTANCE_ROLES as readonly string[]).includes(raw)) {
    throw new InstanceRoleError(
      `${INSTANCE_ROLE_ENV} has unsupported value ${JSON.stringify(raw)} (expected one of: ${INSTANCE_ROLES.join(', ')}). Refusing to boot.`,
    );
  }
  return raw as InstanceRole;
}

const PRODUCTION_ONLY: readonly InstanceRole[] = ['production'];

/**
 * Every background task server/index.ts starts. Adding a starter to index.ts
 * means adding it here; the guard test fails on any ungated timer or starter.
 * To let a task run on `dev`, list 'dev' in its roles in a reviewed change.
 */
export const BACKGROUND_TASKS = {
  'boot-versioned-migrations': { roles: PRODUCTION_ONLY, what: 'legacy migration orchestrator at boot (schema changes)' },
  'boot-stripe-sync-and-seeds': { roles: PRODUCTION_ONLY, what: 'Stripe schema/backfill plus boot seeds and neural-network syncs' },
  'lesson-image-worker': { roles: PRODUCTION_ONLY, what: 'curriculum cover image generation' },
  'scenario-image-worker': { roles: PRODUCTION_ONLY, what: 'practice scenario image generation' },
  'curriculum-augmentor': { roles: PRODUCTION_ONLY, what: 'Level 3-5 thematic unit augmentation' },
  'canonical-capture-autosave': { roles: PRODUCTION_ONLY, what: 'agent session autosave / canonical conversation capture' },
  'session-monitor': { roles: PRODUCTION_ONLY, what: 'Luca session watchdog' },
  'source-control-scheduler': { roles: PRODUCTION_ONLY, what: 'source-control sync scheduler' },
  'stale-channel-boot-alert': { roles: PRODUCTION_ONLY, what: 'inner-life stale-channel alert seed' },
  'storage-probe-startup': { roles: PRODUCTION_ONLY, what: 'object-storage startup probe and founder alert' },
  'storage-probe-periodic': { roles: PRODUCTION_ONLY, what: 'object-storage periodic probe and founder alert' },
  'storage-copyobject-probe': { roles: PRODUCTION_ONLY, what: 'object-storage CopyObject capability probe' },
  'principle-embeddings-warmup': { roles: PRODUCTION_ONLY, what: 'North Star principle embedding warm-up' },
  'luca-presence': { roles: PRODUCTION_ONLY, what: 'Luca Team Room presence and observer' },
  'hive-sync': { roles: PRODUCTION_ONLY, what: 'hive consciousness listener (peer sync)' },
  'memory-recovery-worker': { roles: PRODUCTION_ONLY, what: 'memory recovery worker' },
  'sofia-issue-monitoring': { roles: PRODUCTION_ONLY, what: 'Sofia issue monitoring worker' },
  'zombie-session-cleanup': { roles: PRODUCTION_ONLY, what: 'zombie voice session cleanup' },
  'voice-health-monitor': { roles: PRODUCTION_ONLY, what: 'voice health monitor and transitions' },
  'context-health-monitor': { roles: PRODUCTION_ONLY, what: 'context health monitor and transitions' },
  'brain-health-aggregator': { roles: PRODUCTION_ONLY, what: 'brain health aggregator and transitions' },
  'wren-security-audit': { roles: PRODUCTION_ONLY, what: 'Wren security audit worker' },
  'reading-module-prefetch': { roles: PRODUCTION_ONLY, what: 'reading module pre-generation' },
  'lyra-analytics': { roles: PRODUCTION_ONLY, what: 'Lyra learning-experience analytics worker' },
  'alden-digest': { roles: PRODUCTION_ONLY, what: 'Alden weekly digest worker' },
  'alden-watch': { roles: PRODUCTION_ONLY, what: 'Alden watch notifications worker' },
  'thread-weaver-refresh': { roles: PRODUCTION_ONLY, what: 'thread weaver monthly refresh' },
  'shared-lobe-snapshot': { roles: PRODUCTION_ONLY, what: 'shared lobe snapshot and watcher' },
  'agent-notes-snapshot': { roles: PRODUCTION_ONLY, what: 'agent notes inbox snapshot' },
  'agent-briefing': { roles: PRODUCTION_ONLY, what: 'agent briefing regeneration' },
  'menu-image-worker': { roles: PRODUCTION_ONLY, what: 'menu food image worker' },
  'sofia-issue-cleanup': { roles: PRODUCTION_ONLY, what: 'Sofia issue cleanup worker' },
  'sophia-student-support': { roles: PRODUCTION_ONLY, what: 'Sophia student support worker' },
  'vocab-image-seed': { roles: PRODUCTION_ONLY, what: 'vocabulary image library seeding' },
  'fact-confidence-decay': { roles: PRODUCTION_ONLY, what: 'fact confidence decay worker' },
  'diagnostic-retention': { roles: PRODUCTION_ONLY, what: 'diagnostic summary and retention purge' },
  'daniela-absence': { roles: PRODUCTION_ONLY, what: 'Daniela absence worker (student nudges)' },
  'agent-and-daniela-workers': { roles: PRODUCTION_ONLY, what: 'presence, team room, dialogue, sweep, founder-chat sync, Monday brief, team-room autosave, consult autosave, coordination delivery, Gemini provider, coordination reaper' },
  'learning-goals-migration': { roles: PRODUCTION_ONLY, what: 'learning goals table migration at boot' },
  'memory-embedding-indexer': { roles: PRODUCTION_ONLY, what: 'memory embedding indexer' },
  'daniela-tool-indexer': { roles: PRODUCTION_ONLY, what: 'Daniela tool indexer' },
  'goal-capability-indexer': { roles: PRODUCTION_ONLY, what: 'learning goal capability indexer' },
  'operation-skill-indexer': { roles: PRODUCTION_ONLY, what: 'agent operation skill indexer' },
  'shadow-auditor-reaper': { roles: PRODUCTION_ONLY, what: 'shadow auditor stale-session reaper' },
  'madrigal-indexing': { roles: PRODUCTION_ONLY, what: 'Madrigal unit embedding indexer' },
  'memory-consolidator': { roles: PRODUCTION_ONLY, what: 'memory consolidator' },
  'session-insight-consolidation': { roles: PRODUCTION_ONLY, what: 'session insight consolidation worker' },
  'voice-drift-baseline': { roles: PRODUCTION_ONLY, what: 'voice drift baseline' },
  'conversation-curator': { roles: PRODUCTION_ONLY, what: 'conversation curator backfill' },
  'curriculum-enrichment-resume': { roles: PRODUCTION_ONLY, what: 'curriculum enrichment boot resume' },
} as const satisfies Record<string, { roles: readonly InstanceRole[]; what: string }>;

export type BackgroundTaskId = keyof typeof BACKGROUND_TASKS;

export interface BackgroundTaskSummary {
  role: InstanceRole;
  started: BackgroundTaskId[];
  skipped: BackgroundTaskId[];
}

export function isBackgroundTaskAllowed(role: InstanceRole, id: BackgroundTaskId): boolean {
  const task = BACKGROUND_TASKS[id];
  return Boolean(task) && (task.roles as readonly InstanceRole[]).includes(role);
}

export function createBackgroundTaskGate(role: InstanceRole, log: (line: string) => void = console.log) {
  const started: BackgroundTaskId[] = [];
  const skipped: BackgroundTaskId[] = [];
  return {
    role,
    /**
     * Records the decision for task `id` and returns whether this instance role
     * may run it. Use for an inline section that cannot be wrapped in run().
     */
    claim(id: BackgroundTaskId): boolean {
      if (!isBackgroundTaskAllowed(role, id)) {
        skipped.push(id);
        log(`[InstanceRole] ${role}: not starting background task "${id}" (${BACKGROUND_TASKS[id].what})`);
        return false;
      }
      started.push(id);
      return true;
    },
    /** Runs `start` only when this instance role may run task `id`. */
    run(id: BackgroundTaskId, start: () => unknown): void {
      if (!this.claim(id)) return;
      start();
    },
    summary(): BackgroundTaskSummary {
      return { role, started: [...started], skipped: [...skipped] };
    },
  };
}
