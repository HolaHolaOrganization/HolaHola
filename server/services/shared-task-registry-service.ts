import { sql } from 'drizzle-orm';
import { canonicalJson } from './task-ownership-service';
import { normalizeCoordinationRepositoryIdentity } from './coordination-repository-identity';
import {
  artifactBytes, digest, fail, renderTaskArtifact, taskInput, taskReference, text,
  TASK_ACTOR_DAILY_LIMIT, TASK_ACTOR_OUTSTANDING_LIMIT, TASK_STATES, type TaskInput,
} from './shared-task-registry-contract';

type Executor = { execute(query: any): Promise<any> };
export type RegistryDatabase = Executor & {
  transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T>;
};
export type RegistryTask = {
  task_ref: string; repository_identity: string; starting_commit: string;
  source_kind: string; creator_actor: string | null; source_thread: string | null;
  artifact_sha256: string; artifact_base64: string; definition: unknown;
  state: string; version: number; created_at: Date | string;
  ownership: { status: 'not_assessed'; grantsAuthority: false };
};
const rows = (result: any): any[] => Array.isArray(result) ? result : result.rows;
async function query(tx: Executor, statement: any) { return rows(await tx.execute(statement)); }
async function lock(tx: Executor, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
const selection = sql`SELECT d.*, l.state, l.version FROM shared_task_definitions d
  JOIN shared_task_lifecycle l USING(task_ref)`;
async function read(tx: Executor, ref: string): Promise<RegistryTask> {
  const [task] = await query(tx, sql`${selection} WHERE d.task_ref=${ref}`);
  if (!task) return fail('TASK_NOT_FOUND');
  return { ...task, ownership: { status: 'not_assessed', grantsAuthority: false } };
}
function registration(task: RegistryTask) {
  // Replay returns immutable registration only. Live lifecycle is discovered
  // through show/list; including it here would make an exact retry change.
  const { state: _state, version: _version, ...identity } = task;
  return identity;
}
export class SharedTaskRegistry {
  constructor(
    private readonly database: () => Promise<RegistryDatabase>,
    private readonly repository: string,
    private readonly verifyOwner: (actor: string, ref: string, sha: string, proof: unknown) => Promise<boolean>,
  ) {}
  private async ready(tx: Executor) {
    const [gate] = await query(tx, sql`SELECT ready FROM shared_task_registry_gate WHERE id=1`);
    if (gate?.ready !== true) fail('REGISTRY_NOT_READY');
  }
  private project(input: TaskInput) {
    if (input.repositoryIdentity !== normalizeCoordinationRepositoryIdentity(this.repository)) fail('PROJECT_FORBIDDEN');
  }
  async show(ref: string) {
    const db = await this.database();
    await this.ready(db);
    const result = await read(db, taskReference(ref));
    if (result.repository_identity !== normalizeCoordinationRepositoryIdentity(this.repository)) fail('PROJECT_FORBIDDEN');
    return result;
  }
  async list(after = '0', limit = 25) {
    if (after !== '0') taskReference(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_PAGE');
    const db = await this.database();
    await this.ready(db);
    const result = await query(db, sql`${selection} WHERE d.repository_identity=${normalizeCoordinationRepositoryIdentity(this.repository)}
      AND (length(d.task_ref)>length(${after}) OR (length(d.task_ref)=length(${after}) AND d.task_ref>${after}))
      ORDER BY length(d.task_ref), d.task_ref LIMIT ${limit}`);
    return result.map(task => ({ ...task, ownership: { status: 'not_assessed', grantsAuthority: false } }));
  }
  async create(actor: string, key: string, raw: Record<string, unknown>, imported = false) {
    text(actor, 128); text(key, 128);
    const input = taskInput(raw);
    this.project(input);
    const kind = imported ? raw.sourceKind : 'hat';
    if (!['hat', 'replit', 'bootstrap'].includes(String(kind))) fail('INVALID_SOURCE_KIND');
    const refInput = imported ? taskReference(raw.taskRef) : null;
    const supplied = imported ? artifactBytes(raw.artifactBase64) : null;
    // Proof is ephemeral authorization, never part of task identity or persisted.
    const requestDigest = digest(canonicalJson({ ...input, kind, ref: refInput,
      artifactSha256: supplied ? digest(supplied) : null }));
    const operation = imported ? 'import' : 'create';
    const db = await this.database();
    return db.transaction(async tx => {
      await this.ready(tx);
      // Order: request -> actor bound -> global allocator -> ref.
      // Legacy publishers/ownership take only the same bare-ref lock.
      await lock(tx, `registry-request:${operation}:${actor}:${key}`);
      const [prior] = await query(tx, sql`SELECT * FROM shared_task_requests
        WHERE operation=${operation} AND actor=${actor} AND request_key=${key}`);
      if (prior) {
        if (prior.request_digest !== requestDigest) fail('IDEMPOTENCY_CONFLICT');
        return registration(await read(tx, prior.task_ref));
      }
      const [thread] = await query(tx, sql`SELECT id FROM coordination_threads t WHERE id=${input.sourceThread}
        AND (origin_actor=${actor} OR intended_recipient=${actor} OR current_owner=${actor}
          OR EXISTS(SELECT 1 FROM coordination_events e WHERE e.thread_id=t.id AND
            (e.actor=${actor} OR e.recipient_actor=${actor})))`);
      if (!thread) fail('SOURCE_THREAD_FORBIDDEN');
      await lock(tx, `registry-actor:${actor}`);
      const [count] = await query(tx, sql`SELECT
        count(*) FILTER (WHERE d.created_at>now()-interval '1 day') AS daily,
        count(*) FILTER (WHERE l.state NOT IN ('completed','cancelled')) AS outstanding
        FROM shared_task_definitions d JOIN shared_task_lifecycle l USING(task_ref)
        WHERE d.creator_actor=${actor}`);
      let ref = refInput;
      await lock(tx, 'registry-allocator');
      // Exact existing imports do not consume a new allocation bound.
      if (!ref) {
        if (Number(count.daily) >= TASK_ACTOR_DAILY_LIMIT || Number(count.outstanding) >= TASK_ACTOR_OUTSTANDING_LIMIT) fail('ALLOCATION_LIMIT');
        let next;
        try { [next] = await query(tx, sql`SELECT nextval('shared_task_reference_sequence')::text AS ref`); }
        catch (err) {
          if ((err as { cause?: { code?: string } }).cause?.code === '2200H') fail('ALLOCATION_EXHAUSTED');
          throw err;
        }
        ref = taskReference(next.ref);
      }
      const bytes = supplied || renderTaskArtifact(ref, actor, input);
      artifactBytes(bytes.toString('base64'));
      const sha = digest(bytes);
      // The proof verifier has its own transaction/locks: never call it while
      // holding the task-ref lock in this transaction.
      if (kind === 'bootstrap' && !await this.verifyOwner(actor, ref, sha, raw.proof)) fail('BOOTSTRAP_PROOF_REQUIRED');
      await lock(tx, ref);
      const [reservation] = await query(tx, sql`SELECT * FROM shared_task_reservations WHERE task_ref=${ref}`);
      if (reservation && (kind !== 'bootstrap' || reservation.actor !== actor || reservation.artifact_sha256 !== sha)) fail('RESERVATION_CONFLICT');
      const [existing] = await query(tx, sql`SELECT * FROM shared_task_definitions WHERE task_ref=${ref}`);
      if (existing) {
        if (existing.artifact_base64 !== bytes.toString('base64') || existing.artifact_sha256 !== sha ||
            existing.repository_identity !== input.repositoryIdentity || existing.starting_commit !== input.startingCommit) fail('TASK_CONFLICT');
        const priorInput = { ...existing.definition, repositoryIdentity: existing.repository_identity,
          startingCommit: existing.starting_commit, sourceThread: existing.source_thread, supersedes: existing.supersedes };
        if (existing.source_kind !== 'legacy' && Object.entries(input).some(([key, value]) =>
          canonicalJson(priorInput[key] ?? null) !== canonicalJson(value))) fail('TASK_CONFLICT');
        // Repeated import cannot replace labels, creator, source or provenance.
      } else {
        if (Number(count.daily) >= TASK_ACTOR_DAILY_LIMIT || Number(count.outstanding) >= TASK_ACTOR_OUTSTANDING_LIMIT) fail('ALLOCATION_LIMIT');
        if (input.supersedes && (await read(tx, input.supersedes)).repository_identity !== input.repositoryIdentity) fail('PROJECT_FORBIDDEN');
        const definition = { ...input, platformProvenance: kind === 'replit'
          ? { declaredBy: actor, verified: false } : null };
        await tx.execute(sql`INSERT INTO shared_task_definitions
          (task_ref,repository_identity,starting_commit,source_kind,creator_actor,source_thread,supersedes,definition,artifact_base64,artifact_sha256)
          VALUES (${ref},${input.repositoryIdentity},${input.startingCommit},${kind},${actor},${input.sourceThread},
            ${input.supersedes},${JSON.stringify(definition)}::jsonb,${bytes.toString('base64')},${sha})`);
        await tx.execute(sql`INSERT INTO shared_task_lifecycle(task_ref) VALUES (${ref})`);
        await tx.execute(sql`INSERT INTO shared_task_events(task_ref,version,actor,state,reason)
          VALUES (${ref},1,${actor},'proposed','Registered; no execution authority conferred')`);
        await tx.execute(sql`INSERT INTO coordination_v2_task_artifacts
          (task_ref,artifact_base64,task_artifact_sha256,repository_identity,starting_commit,published_by)
          VALUES (${ref},${bytes.toString('base64')},${sha},${input.repositoryIdentity},${input.startingCommit},${actor})`);
      }
      await tx.execute(sql`INSERT INTO shared_task_requests(operation,actor,request_key,request_digest,task_ref)
        VALUES (${operation},${actor},${key},${requestDigest},${ref})`);
      return registration(await read(tx, ref));
    });
  }
  async transition(actor: string, ref: string, raw: Record<string, unknown>) {
    ref = taskReference(ref);
    if (!TASK_STATES.includes(raw.state as any) || !Number.isSafeInteger(raw.expectedVersion) ||
        (raw.expectedVersion as number) < 1) fail('INVALID_TRANSITION');
    const reason = text(raw.reason, 4000);
    const task = await this.show(ref);
    if (actor !== task.creator_actor && actor !== 'david' &&
        !await this.verifyOwner(actor, ref, task.artifact_sha256, raw.proof)) fail('TRANSITION_FORBIDDEN');
    const db = await this.database();
    return db.transaction(async tx => {
      await lock(tx, ref);
      const [changed] = await query(tx, sql`UPDATE shared_task_lifecycle SET state=${raw.state},
        version=version+1,updated_at=now() WHERE task_ref=${ref} AND version=${raw.expectedVersion} RETURNING version`);
      if (!changed) fail('VERSION_CONFLICT');
      await tx.execute(sql`INSERT INTO shared_task_events(task_ref,version,actor,state,reason)
        VALUES (${ref},${changed.version},${actor},${raw.state},${reason})`);
      return read(tx, ref);
    });
  }
}

/** Lazy import keeps portable CLI and hermetic contracts free of ambient DBs. */
export function productionTaskRegistry(repository: string) {
  return new SharedTaskRegistry(async () => (await import('../db')).getSharedDb() as unknown as RegistryDatabase,
    repository, async (actor, ref, sha, proof) => {
      if (!proof || typeof proof !== 'object') return false;
      const { nonceId, signature } = proof as { nonceId: string; signature: string };
      const result = await (await import('./founder-task-ownership-service')).verifyProof(nonceId, signature, actor);
      return result.verified === true && result.taskRef === ref && result.intendedActor === actor && result.artifactSha256 === sha;
    });
}
