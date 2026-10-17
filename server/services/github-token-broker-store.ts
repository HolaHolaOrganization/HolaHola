/**
 * Database access for the GitHub token broker (github_app_grants,
 * github_token_audit_events). Every state change is a conditional UPDATE on the
 * expected prior state, so concurrent decisions cannot skip a transition.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { githubAppGrants, githubTokenAuditEvents, type GithubAppGrant } from '@shared/schema';
import { getSharedDb } from '../db';
import {
  GRANT_LIFETIME_DAYS,
  GRANT_TRANSITIONS,
  type GithubTokenAuditEvent,
  type GithubTokenBrokerStore,
  type GrantDecision,
  type GrantProposal,
  scrubAuditMetadata,
} from './github-token-broker';

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

export const githubTokenBrokerStore: GithubTokenBrokerStore & {
  propose(proposal: GrantProposal, proposedBy: string): Promise<GithubAppGrant>;
  decide(id: string, decision: GrantDecision, founder: string): Promise<GithubAppGrant>;
  list(): Promise<{ grants: GithubAppGrant[]; recentAudit: unknown[] }>;
} = {
  async findLiveGrant(actor) {
    const rows = await getSharedDb().select().from(githubAppGrants)
      .where(and(eq(githubAppGrants.actor, actor), inArray(githubAppGrants.state, ['active', 'disabled'])))
      .limit(2);
    // The partial unique index allows at most one; more would be corruption, so fail closed.
    return rows.length === 1 ? rows[0] : null;
  },

  async audit(event: GithubTokenAuditEvent) {
    await getSharedDb().insert(githubTokenAuditEvents).values({
      eventType: event.eventType,
      success: event.success,
      actor: event.actor ?? null,
      grantId: event.grantId ?? null,
      appId: event.appId ?? null,
      installationId: event.installationId ?? null,
      reason: event.reason?.slice(0, 160) ?? null,
      metadata: scrubAuditMetadata(event.metadata),
    });
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
    const now = new Date();
    const set: Partial<typeof githubAppGrants.$inferInsert> = { state: transition.to, updatedAt: now };
    if (decision === 'approve') {
      set.decidedBy = founder;
      set.decidedAt = now;
      set.expiresAt = new Date(now.getTime() + GRANT_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
    } else if (decision === 'reject') {
      set.decidedBy = founder;
      set.decidedAt = now;
    } else if (decision === 'revoke') {
      set.revokedBy = founder;
      set.revokedAt = now;
    }
    let updated: GithubAppGrant[];
    try {
      updated = await getSharedDb().update(githubAppGrants).set(set)
        .where(and(
          eq(githubAppGrants.id, id),
          inArray(githubAppGrants.state, [...transition.from]),
          // Re-enabling never resurrects an expired grant.
          decision === 'enable' ? sql`${githubAppGrants.expiresAt} > now()` : sql`true`,
        ))
        .returning();
    } catch (error) {
      // Unique violation: another live grant already exists for this actor.
      if (isUniqueViolation(error)) throw new GithubGrantError('CONFLICT');
      throw error;
    }
    if (updated.length !== 1) {
      const [existing] = await getSharedDb().select({ id: githubAppGrants.id }).from(githubAppGrants).where(eq(githubAppGrants.id, id));
      throw new GithubGrantError(existing ? 'CONFLICT' : 'NOT_FOUND');
    }
    const grant = updated[0];
    await this.audit({
      eventType: 'grant_decided', success: true, actor: grant.actor, grantId: grant.id,
      appId: grant.appId, installationId: grant.installationId, reason: decision, metadata: { founder, state: grant.state },
    });
    return grant;
  },

  async list() {
    const db = getSharedDb();
    const grants = await db.select().from(githubAppGrants).orderBy(desc(githubAppGrants.createdAt)).limit(100);
    const recentAudit = await db.select().from(githubTokenAuditEvents).orderBy(desc(githubTokenAuditEvents.createdAt)).limit(50);
    return { grants, recentAudit };
  },
};
