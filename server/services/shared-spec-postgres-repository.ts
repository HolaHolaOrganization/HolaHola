import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  sharedSpecDocuments,
  sharedSpecReviewerPolicies,
  sharedSpecReviews,
  sharedSpecRevisions,
} from "@shared/schema";
import type {
  IdempotencyRecord,
  ReviewerPolicyVersion,
  SharedSpecDocument,
  SharedSpecRepository,
  SharedSpecReview,
  SharedSpecRevision,
  SharedSpecTransaction,
} from "./shared-spec-core";

/**
 * PostgreSQL implementation of the small persistence port used by the
 * shared-spec domain.  It deliberately accepts a Drizzle database rather than
 * importing the application's database singleton, so it is usable by any
 * PostgreSQL host (including a plain node-postgres Drizzle instance).
 */
type DrizzleTransaction = any;
type DrizzleDatabase = { transaction<T>(work: (tx: DrizzleTransaction) => Promise<T>): Promise<T> };

const documentFromRow = (row: any): SharedSpecDocument => ({
  id: row.id, title: row.title, summary: row.summary ?? undefined, kind: row.kind,
  repository: row.canonicalRepository, gitPath: row.canonicalPath,
  liveInstructionDocument: row.liveInstructionDocument ?? false,
  currentRevisionId: row.currentRevisionId!, state: row.state,
  creatorActorId: row.creatorActor, createdAt: row.createdAt, updatedAt: row.updatedAt,
});
const revisionFromRow = (row: any): SharedSpecRevision => ({
  id: row.id, documentId: row.documentId, parentRevisionId: row.parentRevisionId ?? undefined,
  markdown: row.markdown, contentHash: row.contentHash, authorActorId: row.authorActor,
  idempotencyKey: row.idempotencyKey, requestDigest: row.requestDigest, createdAt: row.createdAt,
});
const policyFromRow = (row: any): ReviewerPolicyVersion => ({
  id: row.id, version: row.version, actorId: row.actorId, capability: row.capability,
  active: row.isActive, documentKind: row.documentKind ?? undefined, provenance: row.provenance,
  effectiveAt: row.effectiveAt, changedByActorId: row.createdByActor,
});
const reviewFromRow = (row: any): SharedSpecReview => ({
  id: row.id, documentId: row.documentId, revisionId: row.revisionId,
  revisionContentHash: row.revisionContentHash,
  requestedByActorId: row.requestedByActor, idempotencyKey: row.idempotencyKey, requestDigest: row.requestDigest,
  requestedReviewerActorId: row.requestedReviewerActor ?? undefined,
  claimedReviewerActorId: row.claimedReviewerActor ?? undefined,
  decisionActorId: row.decisionActor ?? undefined, state: row.state,
  rationale: row.decisionRationale ?? undefined, evidenceReferences: row.evidenceReferences ?? [],
  requestedAt: row.createdAt, claimedAt: row.claimedAt ?? undefined, decidedAt: row.decidedAt ?? undefined,
  cancelledAt: row.cancelledAt ?? undefined,
  decisionPolicyVersionId: row.decisionPolicyVersionId ?? undefined,
  decisionPolicyVersion: row.decisionPolicyVersion ?? undefined,
  decisionPolicyActorId: row.decisionPolicyActorId ?? undefined,
  decisionPolicyCapability: row.decisionPolicyCapability ?? undefined,
  decisionPolicyActive: row.decisionPolicyActive ?? undefined,
  decisionPolicyDocumentKind: row.decisionPolicyDocumentKind ?? undefined,
  decisionPolicyEffectiveAt: row.decisionPolicyEffectiveAt ?? undefined,
});

export class PostgresSharedSpecRepository implements SharedSpecRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  async transaction<T>(work: (tx: SharedSpecTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async database => work(this.transactionPort(database)));
  }

  private transactionPort(db: DrizzleTransaction): SharedSpecTransaction {
    return {
      getDocument: async id => {
        const [row] = await db.select().from(sharedSpecDocuments).where(eq(sharedSpecDocuments.id, id));
        return row ? documentFromRow(row) : undefined;
      },
      getDocumentByDestination: async (repository, gitPath) => {
        const [row] = await db.select().from(sharedSpecDocuments).where(and(
          eq(sharedSpecDocuments.canonicalRepository, repository),
          eq(sharedSpecDocuments.canonicalPath, gitPath),
          ne(sharedSpecDocuments.state, "archived"),
        ));
        return row ? documentFromRow(row) : undefined;
      },
      listDocuments: async () => (await db.select().from(sharedSpecDocuments).orderBy(desc(sharedSpecDocuments.updatedAt))).map(documentFromRow),
      insertDocument: async document => {
        await db.insert(sharedSpecDocuments).values({
          id: document.id, title: document.title, summary: document.summary, kind: document.kind,
          canonicalRepository: document.repository, canonicalPath: document.gitPath,
          liveInstructionDocument: document.liveInstructionDocument,
          currentRevisionId: document.currentRevisionId, state: document.state,
          creatorActor: document.creatorActorId, createdAt: document.createdAt, updatedAt: document.updatedAt,
        });
      },
      updateDocument: async document => {
        await db.update(sharedSpecDocuments).set({
          title: document.title, summary: document.summary, state: document.state,
          currentRevisionId: document.currentRevisionId, updatedAt: document.updatedAt,
        }).where(eq(sharedSpecDocuments.id, document.id));
      },
      getRevision: async id => {
        const [row] = await db.select().from(sharedSpecRevisions).where(eq(sharedSpecRevisions.id, id));
        return row ? revisionFromRow(row) : undefined;
      },
      listRevisions: async documentId => (await db.select().from(sharedSpecRevisions)
        .where(eq(sharedSpecRevisions.documentId, documentId)).orderBy(sharedSpecRevisions.createdAt)).map(revisionFromRow),
      insertRevision: async revision => {
        await db.insert(sharedSpecRevisions).values({
          id: revision.id, documentId: revision.documentId, parentRevisionId: revision.parentRevisionId,
          markdown: revision.markdown, contentHash: revision.contentHash, authorActor: revision.authorActorId,
          idempotencyKey: revision.idempotencyKey,
          requestDigest: revision.requestDigest, createdAt: revision.createdAt,
        });
      },
      compareAndSetCurrentRevision: async (id, expected, next, state, updatedAt) => {
        const updated = await db.update(sharedSpecDocuments).set({
          currentRevisionId: next, state, updatedAt,
        }).where(and(eq(sharedSpecDocuments.id, id), eq(sharedSpecDocuments.currentRevisionId, expected)))
          .returning({ id: sharedSpecDocuments.id });
        return updated.length === 1;
      },
      getReview: async id => {
        const [row] = await db.select().from(sharedSpecReviews).where(eq(sharedSpecReviews.id, id));
        return row ? reviewFromRow(row) : undefined;
      },
      listReviews: async documentId => (await db.select().from(sharedSpecReviews)
        .where(eq(sharedSpecReviews.documentId, documentId)).orderBy(sharedSpecReviews.createdAt)).map(reviewFromRow),
      listReviewsForReviewer: async actorId => (await db.select().from(sharedSpecReviews)
        .where(and(
          eq(sharedSpecReviews.state, "pending"),
          or(eq(sharedSpecReviews.requestedReviewerActor, actorId), eq(sharedSpecReviews.claimedReviewerActor, actorId)),
        ))
        .orderBy(sharedSpecReviews.createdAt)).map(reviewFromRow),
      listOpenReviews: async () => (await db.select().from(sharedSpecReviews)
        .where(and(
          eq(sharedSpecReviews.state, "pending"),
          isNull(sharedSpecReviews.requestedReviewerActor),
          isNull(sharedSpecReviews.claimedReviewerActor),
        ))
        .orderBy(sharedSpecReviews.createdAt)).map(reviewFromRow),
      insertReview: async review => {
        await db.insert(sharedSpecReviews).values({
          id: review.id, documentId: review.documentId, revisionId: review.revisionId,
          revisionContentHash: review.revisionContentHash,
          requestedByActor: review.requestedByActorId,
          requestedReviewerActor: review.requestedReviewerActorId,
          claimedReviewerActor: review.claimedReviewerActorId, decisionActor: review.decisionActorId,
          state: review.state, decisionRationale: review.rationale,
          evidenceReferences: [...review.evidenceReferences], createdAt: review.requestedAt,
          claimedAt: review.claimedAt, decidedAt: review.decidedAt, cancelledAt: review.cancelledAt,
          decisionPolicyVersionId: review.decisionPolicyVersionId,
          decisionPolicyVersion: review.decisionPolicyVersion,
          decisionPolicyActorId: review.decisionPolicyActorId,
          decisionPolicyCapability: review.decisionPolicyCapability,
          decisionPolicyActive: review.decisionPolicyActive,
          decisionPolicyDocumentKind: review.decisionPolicyDocumentKind,
          decisionPolicyEffectiveAt: review.decisionPolicyEffectiveAt,
          idempotencyKey: review.idempotencyKey, requestDigest: review.requestDigest,
        });
      },
      updateReview: async review => {
        await db.update(sharedSpecReviews).set({
          requestedReviewerActor: review.requestedReviewerActorId, claimedReviewerActor: review.claimedReviewerActorId,
          decisionActor: review.decisionActorId, state: review.state, decisionRationale: review.rationale,
          evidenceReferences: [...review.evidenceReferences], claimedAt: review.claimedAt, decidedAt: review.decidedAt,
          cancelledAt: review.cancelledAt,
          decisionPolicyVersionId: review.decisionPolicyVersionId, decisionPolicyVersion: review.decisionPolicyVersion,
          decisionPolicyActorId: review.decisionPolicyActorId, decisionPolicyCapability: review.decisionPolicyCapability,
          decisionPolicyActive: review.decisionPolicyActive, decisionPolicyDocumentKind: review.decisionPolicyDocumentKind,
          decisionPolicyEffectiveAt: review.decisionPolicyEffectiveAt,
        }).where(eq(sharedSpecReviews.id, review.id));
      },
      compareAndSetReviewClaim: async (reviewId, claimedReviewerActorId, claimedAt) => {
        const updated = await db.update(sharedSpecReviews).set({
          claimedReviewerActor: claimedReviewerActorId, claimedAt,
        }).where(and(
          eq(sharedSpecReviews.id, reviewId),
          eq(sharedSpecReviews.state, "pending"),
          isNull(sharedSpecReviews.claimedReviewerActor),
        )).returning({ id: sharedSpecReviews.id });
        return updated.length === 1;
      },
      compareAndSetReviewAssignment: async (reviewId, reviewerActorId, expectedRequestedReviewerActorId, expectedClaimedReviewerActorId) => {
        const updated = await db.update(sharedSpecReviews).set({
          // Explicit null literals, not undefined: Drizzle's set() silently
          // drops any field whose value is undefined instead of writing SQL
          // NULL, so passing undefined here would leave a stale
          // claimed_reviewer_actor/claimed_at in place instead of clearing it.
          requestedReviewerActor: reviewerActorId, claimedReviewerActor: null, claimedAt: null,
        }).where(and(
          eq(sharedSpecReviews.id, reviewId),
          eq(sharedSpecReviews.state, "pending"),
          expectedRequestedReviewerActorId === undefined
            ? isNull(sharedSpecReviews.requestedReviewerActor)
            : eq(sharedSpecReviews.requestedReviewerActor, expectedRequestedReviewerActorId),
          expectedClaimedReviewerActorId === undefined
            ? isNull(sharedSpecReviews.claimedReviewerActor)
            : eq(sharedSpecReviews.claimedReviewerActor, expectedClaimedReviewerActorId),
        )).returning({ id: sharedSpecReviews.id });
        return updated.length === 1;
      },
      compareAndSetReviewDecision: async (review, expectedClaimedReviewerActorId) => {
        const updated = await db.update(sharedSpecReviews).set({
          // Explicit `?? null` throughout: Drizzle's set() silently drops any
          // field whose value is undefined instead of writing SQL NULL, so an
          // absent optional field (e.g. no rationale) must be coalesced here
          // rather than passed through as undefined.
          state: review.state,
          decisionActor: review.decisionActorId,
          decisionRationale: review.rationale ?? null,
          evidenceReferences: [...review.evidenceReferences],
          decidedAt: review.decidedAt ?? null,
          decisionPolicyVersionId: review.decisionPolicyVersionId ?? null,
          decisionPolicyVersion: review.decisionPolicyVersion ?? null,
          decisionPolicyActorId: review.decisionPolicyActorId ?? null,
          decisionPolicyCapability: review.decisionPolicyCapability ?? null,
          decisionPolicyActive: review.decisionPolicyActive ?? null,
          decisionPolicyDocumentKind: review.decisionPolicyDocumentKind ?? null,
          decisionPolicyEffectiveAt: review.decisionPolicyEffectiveAt ?? null,
        }).where(and(
          eq(sharedSpecReviews.id, review.id),
          eq(sharedSpecReviews.state, "pending"),
          eq(sharedSpecReviews.claimedReviewerActor, expectedClaimedReviewerActorId),
        )).returning({ id: sharedSpecReviews.id });
        return updated.length === 1;
      },
      cancelSupersededPendingReviews: async (documentId, currentRevisionId, cancelledAt) => {
        const updated = await db.update(sharedSpecReviews).set({
          state: "cancelled",
          cancelledAt,
        }).where(and(
          eq(sharedSpecReviews.documentId, documentId),
          eq(sharedSpecReviews.state, "pending"),
          ne(sharedSpecReviews.revisionId, currentRevisionId),
        )).returning({ id: sharedSpecReviews.id });
        return updated.length;
      },
      getActivePolicy: async (actorId, capability, kind) => {
        const [row] = await db.select().from(sharedSpecReviewerPolicies).where(and(
          eq(sharedSpecReviewerPolicies.actorId, actorId), eq(sharedSpecReviewerPolicies.capability, capability),
          or(isNull(sharedSpecReviewerPolicies.documentKind), eq(sharedSpecReviewerPolicies.documentKind, kind!)),
        )).orderBy(desc(sharedSpecReviewerPolicies.version)).limit(1);
        return row?.isActive ? policyFromRow(row) : undefined;
      },
      getPolicyById: async id => {
        const [row] = await db.select().from(sharedSpecReviewerPolicies).where(eq(sharedSpecReviewerPolicies.id, id));
        return row ? policyFromRow(row) : undefined;
      },
      insertPolicy: async policy => {
        await db.insert(sharedSpecReviewerPolicies).values({
          id: policy.id, version: policy.version, actorId: policy.actorId, capability: policy.capability,
          isActive: policy.active, documentKind: policy.documentKind, provenance: policy.provenance ?? "unspecified",
          effectiveAt: policy.effectiveAt, createdByActor: policy.changedByActorId,
        });
      },
      nextPolicyVersion: async () => {
        // PostgreSQL does not permit FOR UPDATE on an aggregate. Taking this
        // transaction-scoped table lock serializes max+1 allocation instead.
        await db.execute(sql`lock table shared_spec_reviewer_policies in exclusive mode`);
        const rows = await db.execute(sql`select coalesce(max(version), 0) + 1 as version from shared_spec_reviewer_policies`);
        return Number((rows as any).rows[0].version);
      },
      getIdempotency: async (scope, actor, idempotencyKey) => {
        const result = await db.execute(sql`
          select scope, actor_id, idempotency_key, request_digest, result_type, result_id
          from shared_spec_idempotency_records
          where scope = ${scope} and actor_id = ${actor} and idempotency_key = ${idempotencyKey}
        `);
        const row = (result as any).rows[0];
        return row ? {
          scope: row.scope, actorId: row.actor_id, key: row.idempotency_key,
          requestDigest: row.request_digest, resultType: row.result_type, resultId: row.result_id,
        } as IdempotencyRecord : undefined;
      },
      insertIdempotency: async record => {
        await db.execute(sql`
          insert into shared_spec_idempotency_records
            (scope, actor_id, idempotency_key, request_digest, result_type, result_id)
          values (${record.scope}, ${record.actorId}, ${record.key}, ${record.requestDigest},
            ${record.resultType}, ${record.resultId})
        `);
      },
    };
  }
}