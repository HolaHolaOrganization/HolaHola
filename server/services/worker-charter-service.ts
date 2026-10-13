/**
 * Local Read-only Worker v1 — charters and job discovery (design §4.1, §4.2).
 *
 * The database module is imported lazily so route/service logic can be tested
 * with an in-memory repository and so application startup never depends on the
 * worker_charters table existing (a missing table yields
 * WORKER_CHARTER_SCHEMA_UNAVAILABLE, distinct from DATABASE_UNAVAILABLE).
 */
import { randomUUID } from 'node:crypto';
import {
  WORKER_JOB_SCHEMA, charterBodyDigest, validateWorkerCharterBody, type WorkerCharterBody,
} from '../../shared/worker-contracts';

export class WorkerCharterError extends Error {
  constructor(readonly code:
    | 'WORKER_CHARTER_INVALID' | 'WORKER_CHARTER_NOT_FOUND' | 'WORKER_CHARTER_STATE_CONFLICT'
    | 'WORKER_CHARTER_SCHEMA_UNAVAILABLE' | 'DATABASE_UNAVAILABLE' | 'WORKER_ACTOR_MISMATCH'
    | 'WORKER_JOBS_QUERY_INVALID', readonly details?: Record<string, unknown>) {
    super(code);
  }
}

export type CharterState = 'draft' | 'approved' | 'revoked';
export type CharterRecordView = {
  id: string; version: number; body: WorkerCharterBody; bodyDigest: string; approvalState: CharterState;
  createdBy: string; approvedBy: string | null; approvedAt: string | null; revokedBy: string | null; revokedAt: string | null; createdAt: string;
};

export type WorkerJobView = {
  threadId: string; createdGlobalSequence: number; createdAt: string; originActor: string;
  creationRecipient: string; state: string; currentOwner: string | null; intendedRecipient: string;
  latestSequence: number; sourceReferenceType: string | null; payload: Record<string, unknown>;
};

export interface WorkerCharterRepository {
  tableExists(): Promise<boolean>;
  maxVersion(id: string): Promise<number | null>;
  insert(row: Omit<CharterRecordView, 'createdAt'>): Promise<CharterRecordView>;
  get(id: string, version: number): Promise<CharterRecordView | null>;
  /** Atomic compare-and-set on approval_state; returns null if the expected state did not hold. */
  transition(id: string, version: number, from: CharterState, to: CharterState, actor: string, at: Date): Promise<CharterRecordView | null>;
  listJobs(q: { workerActor: string; charterId: string; charterVersion: number; afterGlobalSequence: number; approvedAt: string; limit: number }): Promise<WorkerJobView[]>;
  countAccepted(q: { workerActor: string; charterId: string; charterVersion: number; notBefore: string; notAfter: string }): Promise<number>;
}

async function guarded<T>(repo: WorkerCharterRepository, fn: () => Promise<T>): Promise<T> {
  let exists: boolean;
  try { exists = await repo.tableExists(); } catch { throw new WorkerCharterError('DATABASE_UNAVAILABLE'); }
  if (!exists) throw new WorkerCharterError('WORKER_CHARTER_SCHEMA_UNAVAILABLE');
  try { return await fn(); } catch (e) {
    if (e instanceof WorkerCharterError) throw e;
    throw new WorkerCharterError('DATABASE_UNAVAILABLE');
  }
}

export async function createCharterDraft(repo: WorkerCharterRepository, input: { id?: string; body: unknown; createdBy: string }) {
  const v = validateWorkerCharterBody(input.body);
  if (!v.ok) throw new WorkerCharterError('WORKER_CHARTER_INVALID', { reason: v.reason });
  const id = input.id ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new WorkerCharterError('WORKER_CHARTER_INVALID', { reason: 'charter_id_invalid' });
  return guarded(repo, async () => {
    const version = ((await repo.maxVersion(id)) ?? 0) + 1;
    return repo.insert({
      id, version, body: v.value, bodyDigest: charterBodyDigest(v.value), approvalState: 'draft',
      createdBy: input.createdBy, approvedBy: null, approvedAt: null, revokedBy: null, revokedAt: null,
    });
  });
}

async function move(repo: WorkerCharterRepository, id: string, version: number, from: CharterState, to: CharterState, actor: string) {
  return guarded(repo, async () => {
    const current = await repo.get(id, version);
    if (!current) throw new WorkerCharterError('WORKER_CHARTER_NOT_FOUND');
    const moved = await repo.transition(id, version, from, to, actor, new Date());
    if (!moved) throw new WorkerCharterError('WORKER_CHARTER_STATE_CONFLICT', { expected: from, actual: current.approvalState });
    return moved;
  });
}
export const approveCharter = (repo: WorkerCharterRepository, id: string, version: number, actor: string) => move(repo, id, version, 'draft', 'approved', actor);
export const revokeCharter = (repo: WorkerCharterRepository, id: string, version: number, actor: string) => move(repo, id, version, 'approved', 'revoked', actor);

export async function getCharter(repo: WorkerCharterRepository, id: string, version: number) {
  return guarded(repo, async () => {
    const c = await repo.get(id, version);
    if (!c) throw new WorkerCharterError('WORKER_CHARTER_NOT_FOUND');
    return c;
  });
}

/** §4.2: read-only job discovery + server-computed window history for the charter's worker actor. */
export async function listWorkerJobs(repo: WorkerCharterRepository, input: {
  callerActor: string; charterId: string; charterVersion: number; after: number; limit: number;
}) {
  if (!Number.isSafeInteger(input.after) || input.after < 0) throw new WorkerCharterError('WORKER_JOBS_QUERY_INVALID', { field: 'after' });
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 50, 1), 100);
  return guarded(repo, async () => {
    const c = await repo.get(input.charterId, input.charterVersion);
    if (!c) throw new WorkerCharterError('WORKER_CHARTER_NOT_FOUND');
    if (c.body.workerActor !== input.callerActor) throw new WorkerCharterError('WORKER_ACTOR_MISMATCH');
    if (!c.approvedAt) return { charterState: c.approvalState, jobs: [], nextAfter: input.after, complete: true, acceptedInWindow: 0 };
    const rows = await repo.listJobs({
      workerActor: c.body.workerActor, charterId: c.id, charterVersion: c.version,
      afterGlobalSequence: input.after, approvedAt: c.approvedAt, limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const acceptedInWindow = await repo.countAccepted({
      workerActor: c.body.workerActor, charterId: c.id, charterVersion: c.version,
      notBefore: c.body.window.notBefore, notAfter: c.body.window.notAfter,
    });
    return {
      charterState: c.approvalState,
      jobs: page,
      nextAfter: page.length ? page[page.length - 1].createdGlobalSequence : input.after,
      complete: rows.length <= limit,
      acceptedInWindow,
    };
  });
}

// ---------------------------------------------------------------------------
// PostgreSQL repository (lazy DB import)
// ---------------------------------------------------------------------------

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
function toView(r: Record<string, unknown>): CharterRecordView {
  return {
    id: String(r.id), version: Number(r.version), body: r.body as WorkerCharterBody, bodyDigest: String(r.body_digest),
    approvalState: r.approval_state as CharterState, createdBy: String(r.created_by),
    approvedBy: (r.approved_by as string) ?? null, approvedAt: iso(r.approved_at),
    revokedBy: (r.revoked_by as string) ?? null, revokedAt: iso(r.revoked_at), createdAt: iso(r.created_at)!,
  };
}

export function createPostgresWorkerCharterRepository(): WorkerCharterRepository {
  const dbmod = async () => {
    const [{ getSharedDb }, { sql }] = await Promise.all([import('../db'), import('drizzle-orm')]);
    return { db: getSharedDb(), sql };
  };
  const rows = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as Record<string, unknown>[];
  return {
    async tableExists() {
      const { db, sql } = await dbmod();
      const r = rows(await db.execute(sql`SELECT to_regclass('public.worker_charters') IS NOT NULL AS present`));
      return r[0]?.present === true;
    },
    async maxVersion(id) {
      const { db, sql } = await dbmod();
      const r = rows(await db.execute(sql`SELECT max(version) AS v FROM worker_charters WHERE id = ${id}`));
      return r[0]?.v == null ? null : Number(r[0].v);
    },
    async insert(v) {
      const { db, sql } = await dbmod();
      const r = rows(await db.execute(sql`
        INSERT INTO worker_charters (id, version, body, body_digest, approval_state, created_by)
        VALUES (${v.id}, ${v.version}, ${JSON.stringify(v.body)}::jsonb, ${v.bodyDigest}, 'draft', ${v.createdBy})
        RETURNING *`));
      return toView(r[0]);
    },
    async get(id, version) {
      const { db, sql } = await dbmod();
      const r = rows(await db.execute(sql`SELECT * FROM worker_charters WHERE id = ${id} AND version = ${version} LIMIT 1`));
      return r[0] ? toView(r[0]) : null;
    },
    async transition(id, version, from, to, actor, at) {
      const { db, sql } = await dbmod();
      const r = to === 'approved'
        ? rows(await db.execute(sql`UPDATE worker_charters SET approval_state = 'approved', approved_by = ${actor}, approved_at = ${at}
            WHERE id = ${id} AND version = ${version} AND approval_state = ${from} RETURNING *`))
        : rows(await db.execute(sql`UPDATE worker_charters SET approval_state = 'revoked', revoked_by = ${actor}, revoked_at = ${at}
            WHERE id = ${id} AND version = ${version} AND approval_state = ${from} RETURNING *`));
      return r[0] ? toView(r[0]) : null;
    },
    async listJobs(q) {
      const { db, sql } = await dbmod();
      const r = rows(await db.execute(sql`
        SELECT t.id AS thread_id, e.global_sequence, e.created_at, t.origin_actor, e.recipient_actor AS creation_recipient,
               t.state, t.current_owner, t.intended_recipient, t.latest_sequence, t.source_reference->>'type' AS source_type, e.payload
        FROM coordination_events e JOIN coordination_threads t ON t.id = e.thread_id
        WHERE e.event_type = 'created'
          AND e.recipient_actor = ${q.workerActor}
          AND e.payload->>'schema' = ${WORKER_JOB_SCHEMA}
          AND e.payload->>'charterId' = ${q.charterId}
          AND (e.payload->>'charterVersion') = ${String(q.charterVersion)}
          AND e.created_at > ${new Date(q.approvedAt)}
          AND e.global_sequence > ${q.afterGlobalSequence}
        ORDER BY e.global_sequence ASC
        LIMIT ${q.limit}`));
      return r.map((x) => ({
        threadId: String(x.thread_id), createdGlobalSequence: Number(x.global_sequence), createdAt: iso(x.created_at)!,
        originActor: String(x.origin_actor), creationRecipient: String(x.creation_recipient), state: String(x.state),
        currentOwner: (x.current_owner as string) ?? null, intendedRecipient: String(x.intended_recipient),
        latestSequence: Number(x.latest_sequence), sourceReferenceType: (x.source_type as string) ?? null,
        payload: x.payload as Record<string, unknown>,
      }));
    },
    async countAccepted(q) {
      const { db, sql } = await dbmod();
      // Counts every acceptance by the worker actor for this charter version inside the window,
      // independent of current participant fields (reassigned-away jobs still count).
      const r = rows(await db.execute(sql`
        SELECT count(*)::int AS n FROM coordination_events
        WHERE event_type = 'accepted' AND actor = ${q.workerActor}
          AND payload->>'charterId' = ${q.charterId}
          AND (payload->>'charterVersion') = ${String(q.charterVersion)}
          AND created_at >= ${new Date(q.notBefore)} AND created_at < ${new Date(q.notAfter)}`));
      return Number(r[0]?.n ?? 0);
    },
  };
}
