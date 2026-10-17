/**
 * Database access for the GitHub token broker (github_app_grants,
 * github_token_audit_events).
 *
 * - Mints run inside a transaction holding FOR SHARE on the actor's live grant
 *   (withMintLock). Founder decisions are UPDATEs in their own transaction with
 *   a lock timeout, so a decision arriving mid-mint waits for that mint to
 *   finish, and a decision that commits first is seen by the next mint.
 * - Every decision is a conditional UPDATE on the expected prior state.
 * - Partial unique indexes keep one live grant per actor, per App and per
 *   installation. github_app_identity_bindings permanently binds an App and
 *   its installation to the first actor the founder APPROVES for them, so no
 *   two actors can ever hold tokens for one GitHub identity, even during a
 *   residual. Concurrent approvals serialize on that table's primary key.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { githubAppGrants, githubAppIdentityBindings, githubTokenAuditEvents, type GithubAppGrant } from '@shared/schema';
import { getSharedDb } from '../db';
import {
  GRANT_LIFETIME_DAYS,
  GRANT_TRANSITIONS,
  buildAuditMetadata,
  type GithubTokenAuditEvent,
  type GithubTokenBrokerStore,
  type GrantDecision,
  type GrantProposal,
} from './github-token-broker';

/** How long a founder decision waits for an in-flight mint (mints hold at most ~30s of GitHub calls). */
export const DECISION_LOCK_TIMEOUT = '45s';
/** How long a mint waits to take its share lock behind a decision. */
export const MINT_LOCK_TIMEOUT = '10s';

/** PostgreSQL unique violation, whether raised directly or wrapped by the query layer. */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class GithubGrantError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT') {
    super(code);
  }
}

type Inserter = Pick<ReturnType<typeof getSharedDb>, 'insert'>;

async function writeAudit(db: Inserter, event: GithubTokenAuditEvent): Promise<void> {
  await db.insert(githubTokenAuditEvents).values({
    eventType: event.eventType,
    success: event.success,
    actor: event.actor ?? null,
    grantId: event.grantId ?? null,
    appId: event.appId ?? null,
    installationId: event.installationId ?? null,
    reason: event.reason?.slice(0, 160) ?? null,
    metadata: buildAuditMetadata(event.metadata),
  });
}

export const githubTokenBrokerStore: GithubTokenBrokerStore & {
  propose(proposal: GrantProposal, proposedBy: string): Promise<GithubAppGrant>;
  decide(id: string, decision: GrantDecision, founder: string): Promise<GithubAppGrant>;
  list(): Promise<{ grants: GithubAppGrant[]; recentAudit: unknown[] }>;
} = {
  async withMintLock(actor, fn) {
    return getSharedDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${MINT_LOCK_TIMEOUT}'`));
      const rows = await tx.select().from(githubAppGrants)
        .where(and(eq(githubAppGrants.actor, actor), inArray(githubAppGrants.state, ['active', 'disabled'])))
        .limit(2)
        .for('share');
      // clock_timestamp(), not now(): now() is the transaction START, which can
      // precede a long lock wait. Read the clock only after the lock is held.
      const clock = await tx.execute(sql`select clock_timestamp() as now`);
      const now = ((clock as unknown as { rows?: Array<{ now: Date | string }> }).rows ?? [])[0]?.now;
      if (!now) throw new Error('database clock unavailable');
      // The partial unique index allows at most one; more would be corruption, so fail closed.
      return fn(rows.length === 1 ? rows[0] : null, new Date(now));
    });
  },

  async audit(event) {
    await writeAudit(getSharedDb(), event);
  },

  async propose(proposal, proposedBy) {
    const [grant] = await getSharedDb().insert(githubAppGrants).values({
      actor: proposal.actor,
      appId: proposal.appId,
      installationId: proposal.installationId,
      state: 'pending',
      proposedBy,
    }).returning();
    await this.audit({
      eventType: 'grant_proposed', success: true, actor: proposal.actor, grantId: grant.id,
      appId: proposal.appId, installationId: proposal.installationId, metadata: { proposedBy },
    });
    return grant;
  },

  async decide(id, decision, founder) {
    const transition = GRANT_TRANSITIONS[decision];
    if (!transition) throw new GithubGrantError('INVALID_INPUT');
    try {
      return await getSharedDb().transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${DECISION_LOCK_TIMEOUT}'`));
        const nowExpr = sql`now()` as unknown as Date;
        const set: Partial<typeof githubAppGrants.$inferInsert> = { state: transition.to, updatedAt: nowExpr };
        if (decision === 'approve') {
          set.decidedBy = founder;
          set.decidedAt = nowExpr;
          set.expiresAt = sql`now() + make_interval(days => ${GRANT_LIFETIME_DAYS})` as unknown as Date;
        } else if (decision === 'reject') {
          set.decidedBy = founder;
          set.decidedAt = nowExpr;
        } else if (decision === 'revoke') {
          set.revokedBy = founder;
          set.revokedAt = nowExpr;
        }
        const updated = await tx.update(githubAppGrants).set(set)
          .where(and(
            eq(githubAppGrants.id, id),
            inArray(githubAppGrants.state, [...transition.from]),
            // Re-enabling never resurrects an expired grant.
            decision === 'enable' ? sql`${githubAppGrants.expiresAt} > now()` : sql`true`,
          ))
          .returning();
        if (updated.length !== 1) {
          const [existing] = await tx.select({ id: githubAppGrants.id }).from(githubAppGrants).where(eq(githubAppGrants.id, id));
          throw new GithubGrantError(existing ? 'CONFLICT' : 'NOT_FOUND');
        }
        const grant = updated[0];
        if (decision === 'approve' || decision === 'enable') {
          // Permanent identity binding: record (insert-if-absent) that this App
          // and installation belong to this actor, then require every binding
          // for them to name this actor. The primary key serializes concurrent
          // first approvals: a second insert waits for the first transaction,
          // then sees its committed row. Only founder approval binds; proposals,
          // rejections and revoked-while-pending grants never do.
          await tx.insert(githubAppIdentityBindings).values([
            { kind: 'app', externalId: grant.appId, actor: grant.actor, grantId: grant.id },
            { kind: 'installation', externalId: grant.installationId, actor: grant.actor, grantId: grant.id },
          ]).onConflictDoNothing();
          const bindings = await tx.select().from(githubAppIdentityBindings).where(sql`
            (${githubAppIdentityBindings.kind} = 'app' and ${githubAppIdentityBindings.externalId} = ${grant.appId})
            or (${githubAppIdentityBindings.kind} = 'installation' and ${githubAppIdentityBindings.externalId} = ${grant.installationId})`);
          if (bindings.length !== 2 || bindings.some((binding) => binding.actor !== grant.actor)) {
            throw new GithubGrantError('CONFLICT');
          }
        }
        await writeAudit(tx, {
          eventType: 'grant_decided', success: true, actor: grant.actor, grantId: grant.id,
          appId: grant.appId, installationId: grant.installationId, reason: decision,
          metadata: { founder, state: grant.state },
        });
        return grant;
      });
    } catch (error) {
      if (error instanceof GithubGrantError) throw error;
      // Another live grant already holds this actor, App or installation.
      if (isUniqueViolation(error)) throw new GithubGrantError('CONFLICT');
      throw error;
    }
  },

  async list() {
    const db = getSharedDb();
    const grants = await db.select().from(githubAppGrants).orderBy(desc(githubAppGrants.createdAt)).limit(100);
    const recentAudit = await db.select().from(githubTokenAuditEvents).orderBy(desc(githubTokenAuditEvents.createdAt)).limit(50);
    return { grants, recentAudit };
  },
};
