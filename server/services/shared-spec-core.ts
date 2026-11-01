import { createHash, randomUUID } from "node:crypto";

/**
 * The shared-spec domain is deliberately free of HTTP, database-driver, and
 * host-platform imports. A PostgreSQL adapter can implement the repository
 * interfaces below; the in-memory implementation is useful for executable
 * domain tests and local embedding.
 */

export type SharedSpecDocumentKind = "design" | "architecture" | "note";
export type SharedSpecDocumentState = "draft" | "ready_for_review" | "approved" | "published" | "merged" | "archived";
export type SharedSpecReviewState = "pending" | "approved" | "rejected" | "cancelled";
export type ReviewerCapability = "reviewer" | "policy_admin";

export interface ActorContext {
  readonly actorId: string;
  /**
   * Authentication adapters may grant policy administration directly. Review
   * eligibility itself is always resolved from the versioned reviewer policy.
   */
  readonly capabilities?: readonly ReviewerCapability[];
}

export interface SharedSpecDocument {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly kind: SharedSpecDocumentKind;
  readonly repository: string;
  readonly gitPath: string;
  /**
   * Set only at creation (see CreateDocumentInput). When true, approving a
   * revision writes canonicalPath directly and commits it in this checkout
   * instead of opening a GitHub PR -- see shared-spec-live-sync.ts and its
   * orchestration in shared-spec-routes.ts. There is no path to flip this on
   * an existing document.
   */
  readonly liveInstructionDocument: boolean;
  readonly currentRevisionId: string;
  readonly state: SharedSpecDocumentState;
  readonly creatorActorId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SharedSpecRevision {
  readonly id: string;
  readonly documentId: string;
  readonly parentRevisionId?: string;
  readonly markdown: string;
  readonly contentHash: string;
  readonly authorActorId: string;
  readonly idempotencyKey: string;
  /** Digest of the mutation request which created this immutable revision. */
  readonly requestDigest: string;
  readonly createdAt: Date;
}

export interface ReviewerPolicyVersion {
  readonly id: string;
  readonly version: number;
  readonly actorId: string;
  readonly capability: ReviewerCapability;
  readonly active: boolean;
  readonly documentKind?: SharedSpecDocumentKind;
  readonly provenance?: string;
  readonly effectiveAt: Date;
  readonly changedByActorId: string;
}

export interface SharedSpecReview {
  readonly id: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly revisionContentHash: string;
  /** Actor that requested the review, distinct from its optional assignee. */
  readonly requestedByActorId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly requestedReviewerActorId?: string;
  readonly claimedReviewerActorId?: string;
  readonly decisionActorId?: string;
  readonly state: SharedSpecReviewState;
  readonly rationale?: string;
  readonly evidenceReferences: readonly string[];
  readonly requestedAt: Date;
  readonly claimedAt?: Date;
  readonly decidedAt?: Date;
  /** Immutable policy evidence captured at the decision, never re-resolved. */
  readonly decisionPolicyVersionId?: string;
  readonly decisionPolicyVersion?: number;
  readonly decisionPolicyActorId?: string;
  readonly decisionPolicyCapability?: ReviewerCapability;
  readonly decisionPolicyActive?: boolean;
  readonly decisionPolicyDocumentKind?: SharedSpecDocumentKind;
  readonly decisionPolicyEffectiveAt?: Date;
}

export interface IdempotencyRecord {
  readonly scope: string;
  readonly actorId: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly resultType: "document" | "revision" | "review" | "policy";
  readonly resultId: string;
}

export interface SharedSpecTransaction {
  getDocument(id: string): Promise<SharedSpecDocument | undefined>;
  /** Only considers non-archived documents, so an archived note frees its destination for reuse. */
  getDocumentByDestination(repository: string, gitPath: string): Promise<SharedSpecDocument | undefined>;
  listDocuments(): Promise<readonly SharedSpecDocument[]>
  insertDocument(document: SharedSpecDocument): Promise<void>;
  updateDocument(document: SharedSpecDocument): Promise<void>;
  getRevision(id: string): Promise<SharedSpecRevision | undefined>;
  listRevisions(documentId: string): Promise<readonly SharedSpecRevision[]>;
  insertRevision(revision: SharedSpecRevision): Promise<void>;
  /**
   * Database implementations must use `WHERE current_revision_id = expected`;
   * false means zero rows changed and the caller must not insert a revision.
   */
  compareAndSetCurrentRevision(
    documentId: string,
    expectedRevisionId: string,
    nextRevisionId: string,
    state: SharedSpecDocumentState,
    updatedAt: Date,
  ): Promise<boolean>;
  getReview(id: string): Promise<SharedSpecReview | undefined>;
  /**
   * Atomically claims a still-open review: database implementations must use
   * `WHERE state = 'pending' AND claimed_reviewer_actor IS NULL`; false means
   * zero rows changed (another actor already won the claim) and the caller
   * must not treat this actor as holding it. Without this, two concurrent
   * claimReview calls can both read the review as unclaimed, both pass their
   * pre-check, and both commit -- the second write silently overwriting the
   * first's claim with no error to either caller. Mirrors
   * compareAndSetCurrentRevision's guard against the identical shape of race
   * for a document's current revision.
   */
  compareAndSetReviewClaim(reviewId: string, claimedReviewerActorId: string, claimedAt: Date): Promise<boolean>;
  /**
   * Atomically reassigns a still-open review: database implementations must
   * use `WHERE state = 'pending' AND requested_reviewer_actor IS [NOT]
   * DISTINCT FROM expectedRequestedReviewerActorId AND
   * claimed_reviewer_actor IS [NOT] DISTINCT FROM
   * expectedClaimedReviewerActorId`. False means zero rows changed (another
   * assignReview, or a claimReview, already changed one of those fields
   * since this transaction read the review) and the caller must not treat
   * the reassignment as having taken effect. Without this, two concurrent
   * assignReview calls can both read the review as pending, both pass their
   * pre-check, and both commit -- the second write silently overwriting the
   * first's reassignment with no error to either caller. Mirrors
   * compareAndSetReviewClaim's guard against the identical shape of race.
   */
  compareAndSetReviewAssignment(
    reviewId: string,
    reviewerActorId: string,
    expectedRequestedReviewerActorId: string | undefined,
    expectedClaimedReviewerActorId: string | undefined,
  ): Promise<boolean>;
  listReviews(documentId: string): Promise<readonly SharedSpecReview[]>;
  /**
   * A reviewer's own queue, across every document: every review still
   * `pending` that is either explicitly assigned to this actor
   * (requestedReviewerActorId) or already claimed by them
   * (claimedReviewerActorId), oldest-requested-first.
   */
  listReviewsForReviewer(actorId: string): Promise<readonly SharedSpecReview[]>;
  /**
   * Every currently `pending` review nobody has been assigned or already
   * claimed -- i.e. still fully open, across every document,
   * oldest-requested-first. Unfiltered by actor or document kind: a caller
   * must still resolve eligibility itself (see
   * SharedSpecCore.listReviewerQueue / assertEligibleReviewer) before
   * treating one of these as claimable by a particular actor.
   */
  listOpenReviews(): Promise<readonly SharedSpecReview[]>;
  insertReview(review: SharedSpecReview): Promise<void>;
  updateReview(review: SharedSpecReview): Promise<void>;
  /**
   * Atomically records a review decision: database implementations must use
   * `WHERE state = 'pending' AND claimed_reviewer_actor =
   * expectedClaimedReviewerActorId`. False means zero rows changed (the
   * claiming actor already decided this review through a different request)
   * and the caller must not apply the decision's document-state side effect.
   * Without this, two concurrent decideReview calls from the same claiming
   * actor (e.g. a rapid double-submit of approve/reject with different
   * idempotency keys) can both read the review as pending and claimed by
   * them, both pass their pre-check, and both commit -- the second write
   * silently overwriting the first's decision with no error to either
   * caller. Mirrors compareAndSetReviewClaim's guard against the identical
   * shape of race.
   */
  compareAndSetReviewDecision(review: SharedSpecReview, expectedClaimedReviewerActorId: string): Promise<boolean>;
  getActivePolicy(
    actorId: string,
    capability: ReviewerCapability,
    kind?: SharedSpecDocumentKind,
  ): Promise<ReviewerPolicyVersion | undefined>;
  getPolicyById(id: string): Promise<ReviewerPolicyVersion | undefined>;
  insertPolicy(policy: ReviewerPolicyVersion): Promise<void>;
  nextPolicyVersion(): Promise<number>;
  getIdempotency(
    scope: string,
    actorId: string,
    key: string,
  ): Promise<IdempotencyRecord | undefined>;
  insertIdempotency(record: IdempotencyRecord): Promise<void>;
}

export interface SharedSpecRepository {
  transaction<T>(work: (tx: SharedSpecTransaction) => Promise<T>): Promise<T>;
}

export type SharedSpecErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "FORBIDDEN"
  | "INVALID_STATE";

export class SharedSpecDomainError extends Error {
  constructor(
    readonly code: SharedSpecErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SharedSpecDomainError";
  }
}

export const hashSharedSpecMarkdown = (markdown: string): string =>
  createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");

const digestRequest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const clone = <T>(value: T): T => structuredClone(value);
const nowDefault = (): Date => new Date();
const canonicalRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const canonicalSpecPathPattern = /^docs\/superpowers\/specs\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
// "note" documents live in their own flat namespace so a fast-shared note can
// never collide with (or be mistaken for) a reviewed docs/superpowers/specs
// destination. Same single-segment shape as canonicalSpecPathPattern: no `/`
// in the character class, so `notes/../x.md` cannot match.
const canonicalNotePathPattern = /^notes\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
/**
 * Exact-path exemption, not a docs/** wildcard: these two files must keep
 * living at their existing repo paths so every hat's normal read
 * (docs/shared-agent-instructions.md, docs/coordination-clients.md) is the
 * live-synced file itself -- see
 * docs/superpowers/specs/2026-09-21-shared-docs-db-canonical-design.md. Only
 * usable by a document actually flagged liveInstructionDocument; an ordinary
 * architecture document still needs the specs/ namespace.
 */
const liveInstructionDocumentPaths = new Set<string>([
  "docs/shared-agent-instructions.md",
  "docs/coordination-clients.md",
]);
const isValidGitPath = (kind: SharedSpecDocumentKind, gitPath: string, liveInstructionDocument: boolean): boolean => {
  if (kind === "note") return canonicalNotePathPattern.test(gitPath);
  if (liveInstructionDocument && liveInstructionDocumentPaths.has(gitPath)) return true;
  return canonicalSpecPathPattern.test(gitPath);
};
const deriveNoteTitle = (gitPath: string) => gitPath.replace(/^notes\//, "").replace(/\.md$/, "");

/**
 * Detects a lost race against `uq_shared_spec_documents_active_destination`
 * (see shared/schema.ts): two hats can both read "no document here yet" for
 * a brand-new note path before either commits, since the create branch below
 * has no in-transaction CAS the way the revise branch does. The database's
 * own unique index is what actually stops the second insert; this only
 * recognizes that specific failure (walking a possible `.cause` chain, since
 * some drivers wrap the underlying driver error) so it can be reported as
 * the same clean CONFLICT the revise branch gives, never a raw DB error.
 * InMemorySharedSpecRepository throws the same shape so both backends are
 * exercised by the same recovery path in tests.
 */
const isActiveDestinationRace = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (value.code === "23505" && value.constraint === "uq_shared_spec_documents_active_destination") return true;
    current = value.cause;
  }
  return false;
};

export interface SharedSpecCoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface CreateDocumentInput {
  title: string;
  summary?: string;
  kind: SharedSpecDocumentKind;
  repository: string;
  gitPath: string;
  markdown: string;
  /** See SharedSpecDocument.liveInstructionDocument. Defaults to false; immutable after creation. */
  liveInstructionDocument?: boolean;
  idempotencyKey: string;
}

export interface AppendRevisionInput {
  documentId: string;
  baseRevisionId: string;
  markdown: string;
  idempotencyKey: string;
}

export interface ShareDocumentInput {
  repository: string;
  gitPath: string;
  markdown: string;
  /** Only used when creating a new note; an existing note's metadata is immutable, matching design/architecture documents. */
  title?: string;
  summary?: string;
  /** Required to revise an existing note; omission on an existing note is a CONFLICT, never a silent overwrite. */
  baseRevisionId?: string;
  idempotencyKey: string;
}

export interface MarkRevisionReadyInput {
  documentId: string;
  revisionId: string;
  requestedReviewerActorId?: string;
  idempotencyKey: string;
}

export interface ReviewDecisionInput {
  reviewId: string;
  rationale?: string;
  evidenceReferences?: readonly string[];
  idempotencyKey: string;
}

/**
 * How a pending review relates to the actor who asked for their discovery
 * queue (see SharedSpecCore.listReviewerQueue): "assigned" (explicitly
 * requested of them, not yet claimed), "claimed" (they already hold the
 * claim), or "open_eligible" (nobody has been assigned or claimed it, and
 * this actor's active reviewer policy covers the document's kind -- claiming
 * it would succeed right now, but it is not reserved for them: any other
 * eligible reviewer could claim it first).
 */
export type ReviewerQueueRelationship = "assigned" | "claimed" | "open_eligible";

export interface ReviewerQueueEntry {
  readonly review: SharedSpecReview;
  readonly relationship: ReviewerQueueRelationship;
}

export class SharedSpecCore {
  private sequence = 0;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly repository: SharedSpecRepository, options: SharedSpecCoreOptions = {}) {
    this.now = options.now ?? nowDefault;
    this.newId = options.newId ?? randomUUID;
  }

  async createDocument(actor: ActorContext, input: CreateDocumentInput): Promise<{
    document: SharedSpecDocument; revision: SharedSpecRevision;
  }> {
    this.required(actor.actorId, "actorId");
    this.required(input.title, "title"); this.required(input.repository, "repository");
    this.required(input.gitPath, "gitPath"); this.required(input.markdown, "markdown");
    this.required(input.idempotencyKey, "idempotencyKey");
    if (!canonicalRepositoryPattern.test(input.repository)) {
      throw new SharedSpecDomainError("VALIDATION", "repository must be a canonical owner/name value");
    }
    if (!isValidGitPath(input.kind, input.gitPath, input.liveInstructionDocument ?? false)) {
      throw new SharedSpecDomainError("VALIDATION", input.kind === "note"
        ? "gitPath must be notes/<safe>.md"
        : "gitPath must be docs/superpowers/specs/<safe>.md, or one of the fixed live-instruction-document paths when liveInstructionDocument is set");
    }
    const requestDigest = digestRequest(input);
    return this.repository.transaction(async tx => {
      const duplicate = await this.idempotent(tx, "create-document", actor.actorId, input.idempotencyKey, requestDigest);
      if (duplicate) {
        const document = await this.mustDocument(tx, duplicate.resultId);
        return { document, revision: await this.mustRevision(tx, document.currentRevisionId) };
      }
      const at = this.now();
      const documentId = this.newId();
      const revisionId = this.newId();
      const revision: SharedSpecRevision = { id: revisionId, documentId, markdown: input.markdown,
        contentHash: hashSharedSpecMarkdown(input.markdown), authorActorId: actor.actorId,
        idempotencyKey: input.idempotencyKey, requestDigest, createdAt: at };
      const document: SharedSpecDocument = { id: documentId, title: input.title, summary: input.summary,
        kind: input.kind, repository: input.repository, gitPath: input.gitPath,
        liveInstructionDocument: input.liveInstructionDocument ?? false, currentRevisionId: revisionId,
        state: "draft", creatorActorId: actor.actorId, createdAt: at, updatedAt: at };
      await tx.insertDocument(document); await tx.insertRevision(revision);
      await tx.insertIdempotency({ scope: "create-document", actorId: actor.actorId, key: input.idempotencyKey,
        requestDigest, resultType: "document", resultId: documentId });
      return { document, revision };
    });
  }

  /**
   * Fast, unreviewed cross-actor sharing: creates a "note" document at the
   * given destination if none exists yet, or appends a revision when
   * `baseRevisionId` matches its current revision. A missing or stale base on
   * an existing note is a CONFLICT, never a silent overwrite.
   *
   * This intentionally duplicates the small CAS-append shape of
   * appendRevision rather than calling it: both repository implementations
   * open a new top-level transaction per call, so nesting one inside this
   * method's own transaction would deadlock the in-memory mutex and risk pool
   * exhaustion against PostgreSQL.
   */
  async shareDocument(actor: ActorContext, input: ShareDocumentInput): Promise<{
    document: SharedSpecDocument; revision: SharedSpecRevision; created: boolean;
  }> {
    this.required(actor.actorId, "actorId"); this.required(input.repository, "repository");
    this.required(input.gitPath, "gitPath"); this.required(input.markdown, "markdown");
    this.required(input.idempotencyKey, "idempotencyKey");
    if (!canonicalRepositoryPattern.test(input.repository)) {
      throw new SharedSpecDomainError("VALIDATION", "repository must be a canonical owner/name value");
    }
    if (!canonicalNotePathPattern.test(input.gitPath)) {
      throw new SharedSpecDomainError("VALIDATION", "gitPath must be notes/<safe>.md");
    }
    const requestDigest = digestRequest(input);
    try {
      return await this.repository.transaction(async tx => {
        const duplicate = await this.idempotent(tx, "share-document", actor.actorId, input.idempotencyKey, requestDigest);
        if (duplicate) {
          // resultId always names the exact revision this call produced (never a
          // documentId), so a replay is immune to a concurrent edit moving the
          // document's currentRevisionId on to someone else's later revision.
          const revision = await this.mustRevision(tx, duplicate.resultId);
          return { document: await this.mustDocument(tx, revision.documentId), revision, created: !revision.parentRevisionId };
        }
        const existing = await tx.getDocumentByDestination(input.repository, input.gitPath);
        const at = this.now();
        if (!existing) {
          const documentId = this.newId(); const revisionId = this.newId();
          const revision: SharedSpecRevision = { id: revisionId, documentId, markdown: input.markdown,
            contentHash: hashSharedSpecMarkdown(input.markdown), authorActorId: actor.actorId,
            idempotencyKey: input.idempotencyKey, requestDigest, createdAt: at };
          const document: SharedSpecDocument = { id: documentId, title: input.title?.trim() || deriveNoteTitle(input.gitPath),
            summary: input.summary, kind: "note", repository: input.repository, gitPath: input.gitPath,
            // Fast-share notes never go through review/approval, so they can
            // never be the target of an approve-time live-instruction sync.
            liveInstructionDocument: false,
            currentRevisionId: revisionId, state: "draft", creatorActorId: actor.actorId, createdAt: at, updatedAt: at };
          await tx.insertDocument(document); await tx.insertRevision(revision);
          await tx.insertIdempotency({ scope: "share-document", actorId: actor.actorId, key: input.idempotencyKey,
            requestDigest, resultType: "revision", resultId: revisionId });
          return { document, revision, created: true };
        }
        if (existing.kind !== "note") {
          // Unreachable while note/spec destinations use disjoint path prefixes;
          // kept as a defensive guard against a future shared-namespace change.
          throw new SharedSpecDomainError("FORBIDDEN", "This destination is not a fast-share note");
        }
        if (!input.baseRevisionId || input.baseRevisionId !== existing.currentRevisionId) {
          throw new SharedSpecDomainError("CONFLICT", "A note already exists at this destination; pull it and retry with its current revision", {
            documentId: existing.id, currentRevisionId: existing.currentRevisionId,
          });
        }
        const revision: SharedSpecRevision = { id: this.newId(), documentId: existing.id,
          parentRevisionId: input.baseRevisionId, markdown: input.markdown, contentHash: hashSharedSpecMarkdown(input.markdown),
          authorActorId: actor.actorId, idempotencyKey: input.idempotencyKey, requestDigest, createdAt: at };
        await tx.insertRevision(revision);
        if (!await tx.compareAndSetCurrentRevision(existing.id, input.baseRevisionId, revision.id, "draft", at)) {
          const current = await this.mustDocument(tx, existing.id);
          throw new SharedSpecDomainError("CONFLICT", "A note already exists at this destination; pull it and retry with its current revision", {
            documentId: current.id, currentRevisionId: current.currentRevisionId,
          });
        }
        await tx.insertIdempotency({ scope: "share-document", actorId: actor.actorId, key: input.idempotencyKey,
          requestDigest, resultType: "revision", resultId: revision.id });
        return { document: { ...existing, currentRevisionId: revision.id, state: "draft", updatedAt: at }, revision, created: false };
      });
    } catch (error) {
      if (error instanceof SharedSpecDomainError || !isActiveDestinationRace(error)) throw error;
      // The transaction above already rolled back, so it cannot be reused to
      // re-read; a fresh call is required, and by the time a unique-violation
      // is visible here the winning transaction is guaranteed committed.
      const raced = await this.findByDestination(input.repository, input.gitPath);
      if (!raced) throw error;
      throw new SharedSpecDomainError("CONFLICT", "A note already exists at this destination; pull it and retry with its current revision", {
        documentId: raced.document.id, currentRevisionId: raced.document.currentRevisionId,
      });
    }
  }

  /** Looks up a document by its canonical destination, e.g. to pull the current revision of a shared note. */
  async findByDestination(repository: string, gitPath: string): Promise<{
    document: SharedSpecDocument; currentRevision: SharedSpecRevision;
  } | undefined> {
    return this.repository.transaction(async tx => {
      const document = await tx.getDocumentByDestination(repository, gitPath);
      if (!document) return undefined;
      return { document, currentRevision: await this.mustRevision(tx, document.currentRevisionId) };
    });
  }

  /** Only a reviewed current live revision may be projected into a Git reconciliation candidate. */
  async approvedLiveInstructionByDestination(repository: string, gitPath: string): Promise<string | undefined> {
    return this.repository.transaction(async tx => {
      const document = await tx.getDocumentByDestination(repository, gitPath);
      if (!document?.liveInstructionDocument || document.state !== "approved") return undefined;
      const revision = await tx.getRevision(document.currentRevisionId);
      if (!revision) return undefined;
      const reviews = await tx.listReviews(document.id);
      if (!reviews.some(review =>
        review.revisionId === revision.id
        && review.revisionContentHash === revision.contentHash
        && review.state === "approved"
        && !!review.decisionActorId
      )) return undefined;
      return revision.markdown;
    });
  }

  async listDocuments(): Promise<readonly SharedSpecDocument[]> {
    return this.repository.transaction(tx => tx.listDocuments());
  }

  async showDocument(documentId: string): Promise<{ document: SharedSpecDocument; currentRevision: SharedSpecRevision }> {
    return this.repository.transaction(async tx => {
      const document = await this.mustDocument(tx, documentId);
      return { document, currentRevision: await this.mustRevision(tx, document.currentRevisionId) };
    });
  }

  async readRevision(revisionId: string): Promise<SharedSpecRevision> {
    return this.repository.transaction(tx => this.mustRevision(tx, revisionId));
  }

  /** Reads a single review by id -- e.g. to resolve reviewId -> documentId/revisionId before reading revision content. */
  async getReview(reviewId: string): Promise<SharedSpecReview> {
    return this.repository.transaction(tx => this.mustReview(tx, reviewId));
  }

  /**
   * A reviewer's queue: every pending review, across every document, that is
   * assigned to this actor or already claimed by them. Lets a reviewer (e.g.
   * Alden) discover waiting review work without already knowing a reviewId.
   */
  async listReviewsForReviewer(actorId: string): Promise<readonly SharedSpecReview[]> {
    this.required(actorId, "actorId");
    return this.repository.transaction(tx => tx.listReviewsForReviewer(actorId));
  }

  /**
   * A reviewer's full discovery queue: everything listReviewsForReviewer
   * would return (assigned to or claimed by this actor), plus every fully
   * open pending review -- no requestedReviewerActorId, unclaimed -- whose
   * document kind this actor's active reviewer policy covers, using the same
   * rule assertEligibleReviewer enforces at claim time (via the shared
   * getEligibleReviewerPolicy helper, so the two can never drift apart).
   *
   * This is the missing half of listReviewsForReviewer: that method only
   * shows work already handed to the actor, so a review left unassigned
   * never appeared for a reviewer who could claim it -- even though
   * claimReview would have succeeded. Each entry's `relationship` tells the
   * two apart, so a caller never mistakes "you could claim this" (open,
   * first-claim-wins) for "you alone are responsible for this" (assigned or
   * already claimed).
   */
  async listReviewerQueue(actorId: string): Promise<readonly ReviewerQueueEntry[]> {
    this.required(actorId, "actorId");
    return this.repository.transaction(async tx => {
      // A pending review can only be decided while its revision is still the
      // document's current one and the document is awaiting review (the same
      // precondition decideReview enforces). Once a newer revision exists or
      // the document is approved at a later revision, the request is
      // superseded: it can never be decided, so it is not queue work.
      const ownEntries: ReviewerQueueEntry[] = [];
      for (const review of await tx.listReviewsForReviewer(actorId)) {
        const { document } = await this.reviewTarget(tx, review);
        if (document.state !== "ready_for_review" || document.currentRevisionId !== review.revisionId) continue;
        ownEntries.push({ review, relationship: review.claimedReviewerActorId === actorId ? "claimed" : "assigned" });
      }
      const openEntries: ReviewerQueueEntry[] = [];
      for (const review of await tx.listOpenReviews()) {
        const { document, revision } = await this.reviewTarget(tx, review);
        if (document.state !== "ready_for_review" || document.currentRevisionId !== review.revisionId) continue;
        if (await this.getEligibleReviewerPolicy(tx, actorId, document, revision)) {
          openEntries.push({ review, relationship: "open_eligible" });
        }
      }
      return [...ownEntries, ...openEntries];
    });
  }

  async listRevisions(documentId: string): Promise<readonly SharedSpecRevision[]> {
    return this.repository.transaction(async tx => {
      await this.mustDocument(tx, documentId);
      return tx.listRevisions(documentId);
    });
  }

  async compareRevisions(leftRevisionId: string, rightRevisionId: string): Promise<{
    left: SharedSpecRevision; right: SharedSpecRevision; identical: boolean;
  }> {
    return this.repository.transaction(async tx => {
      const left = await this.mustRevision(tx, leftRevisionId);
      const right = await this.mustRevision(tx, rightRevisionId);
      if (left.documentId !== right.documentId) throw new SharedSpecDomainError("VALIDATION", "Revisions belong to different documents");
      return { left, right, identical: left.contentHash === right.contentHash };
    });
  }

  async appendRevision(actor: ActorContext, input: AppendRevisionInput): Promise<SharedSpecRevision> {
    this.required(actor.actorId, "actorId"); this.required(input.documentId, "documentId");
    this.required(input.baseRevisionId, "baseRevisionId"); this.required(input.markdown, "markdown"); this.required(input.idempotencyKey, "idempotencyKey");
    const requestDigest = digestRequest(input);
    return this.repository.transaction(async tx => {
      const duplicate = await this.idempotent(tx, `append:${input.documentId}`, actor.actorId, input.idempotencyKey, requestDigest);
      if (duplicate) return this.mustRevision(tx, duplicate.resultId);
      const document = await this.mustDocument(tx, input.documentId);
      if (document.currentRevisionId !== input.baseRevisionId) {
        throw new SharedSpecDomainError("CONFLICT", "Revision base is no longer current", {
          submittedBaseRevisionId: input.baseRevisionId, currentRevisionId: document.currentRevisionId,
        });
      }
      const at = this.now();
      const revision: SharedSpecRevision = { id: this.newId(), documentId: document.id,
        parentRevisionId: input.baseRevisionId, markdown: input.markdown, contentHash: hashSharedSpecMarkdown(input.markdown),
        authorActorId: actor.actorId, idempotencyKey: input.idempotencyKey, requestDigest, createdAt: at };
      // The transaction is rolled back on a failed CAS, so the immutable row
      // cannot escape as an orphan. In PostgreSQL this ordering also permits a
      // foreign key from documents.current_revision_id to revisions.id.
      await tx.insertRevision(revision);
      if (!await tx.compareAndSetCurrentRevision(document.id, input.baseRevisionId, revision.id, "draft", at)) {
        const current = await this.mustDocument(tx, document.id);
        throw new SharedSpecDomainError("CONFLICT", "Revision base is no longer current", {
          submittedBaseRevisionId: input.baseRevisionId, currentRevisionId: current.currentRevisionId,
        });
      }
      await tx.insertIdempotency({ scope: `append:${document.id}`, actorId: actor.actorId, key: input.idempotencyKey,
        requestDigest, resultType: "revision", resultId: revision.id });
      return revision;
    });
  }

  async setReviewerPolicy(actor: ActorContext, input: Omit<ReviewerPolicyVersion, "id" | "version" | "effectiveAt" | "changedByActorId"> & { idempotencyKey: string }): Promise<ReviewerPolicyVersion> {
    this.requirePolicyAdmin(actor); this.required(input.actorId, "policy actorId"); this.required(input.idempotencyKey, "idempotencyKey");
    const requestDigest = digestRequest(input);
    return this.repository.transaction(async tx => {
      const duplicate = await this.idempotent(tx, "set-policy", actor.actorId, input.idempotencyKey, requestDigest);
      if (duplicate) return (await this.policyById(tx, duplicate.resultId));
      const policy: ReviewerPolicyVersion = { id: this.newId(), version: await tx.nextPolicyVersion(), actorId: input.actorId,
        capability: input.capability, active: input.active, documentKind: input.documentKind, provenance: input.provenance,
        effectiveAt: this.now(), changedByActorId: actor.actorId };
      await tx.insertPolicy(policy);
      await tx.insertIdempotency({ scope: "set-policy", actorId: actor.actorId, key: input.idempotencyKey,
        requestDigest, resultType: "policy", resultId: policy.id });
      return policy;
    });
  }

  async markRevisionReady(actor: ActorContext, input: MarkRevisionReadyInput): Promise<SharedSpecReview> {
    this.required(actor.actorId, "actorId"); this.required(input.documentId, "documentId");
    this.required(input.revisionId, "revisionId"); this.required(input.idempotencyKey, "idempotencyKey");
    const requestDigest = digestRequest(input);
    return this.repository.transaction(async tx => {
      const duplicate = await this.idempotent(tx, `ready:${input.documentId}`, actor.actorId, input.idempotencyKey, requestDigest);
      if (duplicate) return this.mustReview(tx, duplicate.resultId);
      const document = await this.mustDocument(tx, input.documentId);
      const revision = await this.mustRevision(tx, input.revisionId);
      this.requireAuthorOrPolicyAdmin(actor, revision);
      if (document.state !== "draft") throw new SharedSpecDomainError("INVALID_STATE", "Only a draft document may be marked ready");
      if (document.currentRevisionId !== revision.id) throw new SharedSpecDomainError("CONFLICT", "Only the current revision may be marked ready");
      if ((await tx.listReviews(document.id)).some(review => review.revisionId === revision.id)) {
        throw new SharedSpecDomainError("CONFLICT", "A review already exists for this revision");
      }
      if (input.requestedReviewerActorId) await this.assertEligibleReviewer(tx, input.requestedReviewerActorId, document, revision);
      const review: SharedSpecReview = { id: this.newId(), documentId: document.id, revisionId: revision.id,
        revisionContentHash: revision.contentHash, requestedByActorId: actor.actorId,
        requestedReviewerActorId: input.requestedReviewerActorId, idempotencyKey: input.idempotencyKey,
        requestDigest, state: "pending", evidenceReferences: [], requestedAt: this.now() };
      await tx.insertReview(review);
      await tx.updateDocument({ ...document, state: "ready_for_review", updatedAt: this.now() });
      await tx.insertIdempotency({ scope: `ready:${document.id}`, actorId: actor.actorId, key: input.idempotencyKey,
        requestDigest, resultType: "review", resultId: review.id });
      return review;
    });
  }

  async claimReview(actor: ActorContext, reviewId: string, idempotencyKey: string): Promise<SharedSpecReview> {
    this.required(actor.actorId, "actorId"); this.required(reviewId, "reviewId"); this.required(idempotencyKey, "idempotencyKey");
    return this.repository.transaction(async tx => {
      const review = await this.mustReview(tx, reviewId); const digest = digestRequest({ reviewId });
      const duplicate = await this.idempotent(tx, `claim:${reviewId}`, actor.actorId, idempotencyKey, digest);
      if (duplicate) return this.mustReview(tx, duplicate.resultId);
      const { document, revision } = await this.reviewTarget(tx, review);
      if (review.state !== "pending" || review.claimedReviewerActorId) throw new SharedSpecDomainError("INVALID_STATE", "Review cannot be claimed");
      if (review.requestedReviewerActorId && review.requestedReviewerActorId !== actor.actorId) throw new SharedSpecDomainError("FORBIDDEN", "Review is assigned to another actor");
      await this.assertEligibleReviewer(tx, actor.actorId, document, revision);
      const claimedAt = this.now();
      // The check above only rules out a claim this transaction has already
      // seen. A second transaction can read the same unclaimed row before
      // either commits, so the actual guard against two claims landing is
      // this atomic compare-and-set, not the read above -- see
      // compareAndSetReviewClaim's contract.
      if (!await tx.compareAndSetReviewClaim(reviewId, actor.actorId, claimedAt)) {
        throw new SharedSpecDomainError("CONFLICT", "Another actor already claimed this review");
      }
      const updated = { ...review, claimedReviewerActorId: actor.actorId, claimedAt };
      await tx.insertIdempotency({ scope: `claim:${reviewId}`, actorId: actor.actorId, key: idempotencyKey, requestDigest: digest, resultType: "review", resultId: reviewId });
      return updated;
    });
  }

  async assignReview(actor: ActorContext, reviewId: string, reviewerActorId: string, idempotencyKey: string): Promise<SharedSpecReview> {
    this.required(actor.actorId, "actorId"); this.required(reviewId, "reviewId"); this.required(reviewerActorId, "reviewerActorId"); this.required(idempotencyKey, "idempotencyKey"); this.requirePolicyAdmin(actor);
    return this.repository.transaction(async tx => {
      const review = await this.mustReview(tx, reviewId); const digest = digestRequest({ reviewId, reviewerActorId });
      const duplicate = await this.idempotent(tx, `assign:${reviewId}`, actor.actorId, idempotencyKey, digest);
      if (duplicate) return this.mustReview(tx, duplicate.resultId);
      const { document, revision } = await this.reviewTarget(tx, review);
      if (review.state !== "pending") throw new SharedSpecDomainError("INVALID_STATE", "Only a pending review may be assigned");
      await this.assertEligibleReviewer(tx, reviewerActorId, document, revision);
      const updated = { ...review, requestedReviewerActorId: reviewerActorId, claimedReviewerActorId: undefined, claimedAt: undefined };
      // The check above only rules out a reassignment this transaction has
      // already seen. A second assignReview (or a claimReview) can read the
      // same review before either commits, so the actual guard against two
      // writes landing is this atomic compare-and-set, not the read above --
      // see compareAndSetReviewAssignment's contract.
      if (!await tx.compareAndSetReviewAssignment(reviewId, reviewerActorId, review.requestedReviewerActorId, review.claimedReviewerActorId)) {
        throw new SharedSpecDomainError("CONFLICT", "Review was reassigned or claimed by another request");
      }
      await tx.insertIdempotency({ scope: `assign:${reviewId}`, actorId: actor.actorId, key: idempotencyKey, requestDigest: digest, resultType: "review", resultId: reviewId });
      return updated;
    });
  }

  async approveReview(actor: ActorContext, input: ReviewDecisionInput): Promise<SharedSpecReview> {
    return this.decideReview(actor, input, "approved");
  }
  async rejectReview(actor: ActorContext, input: ReviewDecisionInput): Promise<SharedSpecReview> {
    return this.decideReview(actor, input, "rejected");
  }

  async exportApprovedBytes(documentId: string, revisionId?: string): Promise<{
    document: SharedSpecDocument; revision: SharedSpecRevision; review: SharedSpecReview; bytes: Buffer;
  }> {
    return this.repository.transaction(async tx => {
      const document = await this.mustDocument(tx, documentId);
      const reviews = await tx.listReviews(documentId);
      if (!revisionId && document.state !== "approved") {
        throw new SharedSpecDomainError("INVALID_STATE", "The current document is not approved; specify an approved revision");
      }
      const selectedRevisionId = revisionId ?? document.currentRevisionId;
      const review = reviews.find(item => item.state === "approved" && item.revisionId === selectedRevisionId);
      if (!review) throw new SharedSpecDomainError("INVALID_STATE", "No approved revision is available for export");
      const revision = await this.mustRevision(tx, review.revisionId);
      if (hashSharedSpecMarkdown(revision.markdown) !== review.revisionContentHash) throw new SharedSpecDomainError("CONFLICT", "Approved revision hash is invalid");
      return { document, revision, review, bytes: Buffer.from(revision.markdown, "utf8") };
    });
  }

  private async decideReview(actor: ActorContext, input: ReviewDecisionInput, decision: "approved" | "rejected"): Promise<SharedSpecReview> {
    this.required(actor.actorId, "actorId"); this.required(input.reviewId, "reviewId"); this.required(input.idempotencyKey, "idempotencyKey");
    return this.repository.transaction(async tx => {
      const review = await this.mustReview(tx, input.reviewId); const digest = digestRequest({ ...input, decision });
      const duplicate = await this.idempotent(tx, `${decision}:${review.id}`, actor.actorId, input.idempotencyKey, digest);
      if (duplicate) return this.mustReview(tx, duplicate.resultId);
      const { document, revision } = await this.reviewTarget(tx, review);
      if (review.state !== "pending" || review.claimedReviewerActorId !== actor.actorId) throw new SharedSpecDomainError("FORBIDDEN", "Only the claiming reviewer may decide this review");
      if (document.state !== "ready_for_review" || document.currentRevisionId !== revision.id) {
        throw new SharedSpecDomainError("CONFLICT", "Only the current ready revision may be decided");
      }
      const policy = await this.assertEligibleReviewer(tx, actor.actorId, document, revision);
      if (hashSharedSpecMarkdown(revision.markdown) !== review.revisionContentHash) throw new SharedSpecDomainError("CONFLICT", "Revision hash does not match review");
      const updated: SharedSpecReview = { ...review, state: decision, decisionActorId: actor.actorId, rationale: input.rationale,
        evidenceReferences: [...(input.evidenceReferences ?? [])], decidedAt: this.now(),
        decisionPolicyVersionId: policy.id, decisionPolicyVersion: policy.version,
        decisionPolicyActorId: policy.actorId, decisionPolicyCapability: policy.capability,
        decisionPolicyActive: policy.active, decisionPolicyDocumentKind: policy.documentKind,
        decisionPolicyEffectiveAt: policy.effectiveAt };
      // The check above only rules out a decision this transaction has
      // already seen. A second decideReview call from the same claiming
      // actor (e.g. a rapid double-submit of approve/reject with different
      // idempotency keys) can read the same claimed-and-pending review before
      // either commits, so the actual guard against two decisions landing is
      // this atomic compare-and-set, not the read above -- see
      // compareAndSetReviewDecision's contract.
      if (!await tx.compareAndSetReviewDecision(updated, actor.actorId)) {
        throw new SharedSpecDomainError("CONFLICT", "Review was already decided by another request");
      }
      await tx.updateDocument({
        ...document,
        state: decision === "approved" ? "approved" : "draft",
        updatedAt: this.now(),
      });
      await tx.insertIdempotency({ scope: `${decision}:${review.id}`, actorId: actor.actorId, key: input.idempotencyKey, requestDigest: digest, resultType: "review", resultId: review.id });
      return updated;
    });
  }

  private async reviewTarget(tx: SharedSpecTransaction, review: SharedSpecReview) {
    return { document: await this.mustDocument(tx, review.documentId), revision: await this.mustRevision(tx, review.revisionId) };
  }
  /**
   * Non-throwing form of the same rule assertEligibleReviewer enforces: an
   * author can never review their own revision, and eligibility otherwise
   * comes only from an active reviewer policy for the document's kind.
   * Shared by the throwing assertion below and listReviewerQueue's read-only
   * discovery pass, so a review that would fail claimReview can never be
   * shown as open_eligible.
   */
  private async getEligibleReviewerPolicy(tx: SharedSpecTransaction, actorId: string, document: SharedSpecDocument, revision: SharedSpecRevision) {
    if (revision.authorActorId === actorId) return undefined;
    return tx.getActivePolicy(actorId, "reviewer", document.kind);
  }
  private async assertEligibleReviewer(tx: SharedSpecTransaction, actorId: string, document: SharedSpecDocument, revision: SharedSpecRevision) {
    const policy = await this.getEligibleReviewerPolicy(tx, actorId, document, revision);
    if (policy) return policy;
    if (revision.authorActorId === actorId) throw new SharedSpecDomainError("FORBIDDEN", "An author cannot review their own revision");
    throw new SharedSpecDomainError("FORBIDDEN", "Actor is not an eligible reviewer");
  }
  private requirePolicyAdmin(actor: ActorContext) {
    if (!actor.capabilities?.includes("policy_admin")) throw new SharedSpecDomainError("FORBIDDEN", "Policy-admin capability is required");
  }
  private requireAuthorOrPolicyAdmin(actor: ActorContext, revision: SharedSpecRevision) {
    if (actor.actorId !== revision.authorActorId && !actor.capabilities?.includes("policy_admin")) {
      throw new SharedSpecDomainError("FORBIDDEN", "Only the revision author or a policy administrator may mark it ready");
    }
  }
  private required(value: string | undefined, name: string) {
    if (!value?.trim()) throw new SharedSpecDomainError("VALIDATION", `${name} is required`);
  }
  private async idempotent(tx: SharedSpecTransaction, scope: string, actorId: string, key: string, requestDigest: string) {
    const existing = await tx.getIdempotency(scope, actorId, key);
    if (!existing) return undefined;
    if (existing.requestDigest !== requestDigest) throw new SharedSpecDomainError("IDEMPOTENCY_MISMATCH", "Idempotency key was reused with a different request");
    return existing;
  }
  private async mustDocument(tx: SharedSpecTransaction, id: string) {
    const value = await tx.getDocument(id); if (!value) throw new SharedSpecDomainError("NOT_FOUND", "Document not found", { documentId: id }); return value;
  }
  private async mustRevision(tx: SharedSpecTransaction, id: string) {
    const value = await tx.getRevision(id); if (!value) throw new SharedSpecDomainError("NOT_FOUND", "Revision not found", { revisionId: id }); return value;
  }
  private async mustReview(tx: SharedSpecTransaction, id: string) {
    const value = await tx.getReview(id); if (!value) throw new SharedSpecDomainError("NOT_FOUND", "Review not found", { reviewId: id }); return value;
  }
  private async policyById(tx: SharedSpecTransaction, id: string): Promise<ReviewerPolicyVersion> {
    // Version ids are only exposed by idempotency replays. A generic repository
    // need not expose policy enumeration, so retrieve it through active lookup is
    // not possible; the in-memory implementation supplies this helper internally.
    const policy = await tx.getPolicyById(id);
    if (!policy) throw new SharedSpecDomainError("NOT_FOUND", "Policy version not found", { policyId: id });
    return policy;
  }
}

/** Serial transactions model PostgreSQL transaction isolation for core tests. */
export class InMemorySharedSpecRepository implements SharedSpecRepository {
  private documents = new Map<string, SharedSpecDocument>();
  private revisions = new Map<string, SharedSpecRevision>();
  private reviews = new Map<string, SharedSpecReview>();
  private policies = new Map<string, ReviewerPolicyVersion>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private policyVersion = 0;
  private lock: Promise<void> = Promise.resolve();

  async transaction<T>(work: (tx: SharedSpecTransaction) => Promise<T>): Promise<T> {
    let release!: () => void; const previous = this.lock; this.lock = new Promise(resolve => { release = resolve; });
    await previous;
    const snapshot = {
      documents: new Map([...this.documents].map(([key, value]) => [key, clone(value)])),
      revisions: new Map([...this.revisions].map(([key, value]) => [key, clone(value)])),
      reviews: new Map([...this.reviews].map(([key, value]) => [key, clone(value)])),
      policies: new Map([...this.policies].map(([key, value]) => [key, clone(value)])),
      idempotency: new Map([...this.idempotency].map(([key, value]) => [key, clone(value)])),
      policyVersion: this.policyVersion,
    };
    try {
      return await work(this.tx());
    } catch (error) {
      this.documents = snapshot.documents; this.revisions = snapshot.revisions; this.reviews = snapshot.reviews;
      this.policies = snapshot.policies; this.idempotency = snapshot.idempotency; this.policyVersion = snapshot.policyVersion;
      throw error;
    } finally { release(); }
  }
  private tx(): SharedSpecTransaction {
    const idemKey = (scope: string, actor: string, key: string) => `${scope}\u0000${actor}\u0000${key}`;
    return {
      getDocument: async id => clone(this.documents.get(id)),
      getDocumentByDestination: async (repository, gitPath) => {
        const match = [...this.documents.values()].find(x => x.repository === repository && x.gitPath === gitPath && x.state !== "archived");
        return clone(match);
      },
      listDocuments: async () => [...this.documents.values()].map(clone),
      insertDocument: async value => {
        // Mirrors uq_shared_spec_documents_active_destination: a partial unique
        // index that ignores archived documents, so an archived note frees its
        // path for reuse. Throws the same low-level shape a real unique
        // violation carries (code + constraint) rather than a domain error, so
        // shareDocument's race-recovery path is exercised identically against
        // both backends -- see isActiveDestinationRace above.
        if (this.documents.has(value.id) || [...this.documents.values()].some(x =>
          x.repository === value.repository && x.gitPath === value.gitPath && x.state !== "archived")) {
          throw Object.assign(
            new Error('duplicate key value violates unique constraint "uq_shared_spec_documents_active_destination"'),
            { code: "23505", constraint: "uq_shared_spec_documents_active_destination" },
          );
        }
        this.documents.set(value.id, clone(value));
      },
      updateDocument: async value => { if (!this.documents.has(value.id)) throw new SharedSpecDomainError("NOT_FOUND", "Document not found"); this.documents.set(value.id, clone(value)); },
      getRevision: async id => clone(this.revisions.get(id)),
      listRevisions: async documentId => [...this.revisions.values()].filter(x => x.documentId === documentId).map(clone),
      insertRevision: async value => { if (this.revisions.has(value.id)) throw new SharedSpecDomainError("CONFLICT", "Revision already exists"); this.revisions.set(value.id, clone(value)); },
      compareAndSetCurrentRevision: async (id, expected, next, state, updatedAt) => {
        const doc = this.documents.get(id); if (!doc || doc.currentRevisionId !== expected) return false;
        this.documents.set(id, { ...doc, currentRevisionId: next, state, updatedAt: new Date(updatedAt) }); return true;
      },
      getReview: async id => clone(this.reviews.get(id)),
      listReviews: async documentId => [...this.reviews.values()].filter(x => x.documentId === documentId).map(clone),
      listReviewsForReviewer: async actorId => [...this.reviews.values()]
        .filter(x => x.state === "pending" && (x.requestedReviewerActorId === actorId || x.claimedReviewerActorId === actorId))
        .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
        .map(clone),
      listOpenReviews: async () => [...this.reviews.values()]
        .filter(x => x.state === "pending" && !x.requestedReviewerActorId && !x.claimedReviewerActorId)
        .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
        .map(clone),
      insertReview: async value => { this.reviews.set(value.id, clone(value)); },
      updateReview: async value => { if (!this.reviews.has(value.id)) throw new SharedSpecDomainError("NOT_FOUND", "Review not found"); this.reviews.set(value.id, clone(value)); },
      compareAndSetReviewClaim: async (reviewId, claimedReviewerActorId, claimedAt) => {
        const review = this.reviews.get(reviewId);
        if (!review || review.state !== "pending" || review.claimedReviewerActorId) return false;
        this.reviews.set(reviewId, { ...review, claimedReviewerActorId, claimedAt: new Date(claimedAt) });
        return true;
      },
      compareAndSetReviewAssignment: async (reviewId, reviewerActorId, expectedRequestedReviewerActorId, expectedClaimedReviewerActorId) => {
        const review = this.reviews.get(reviewId);
        if (!review || review.state !== "pending") return false;
        if (review.requestedReviewerActorId !== expectedRequestedReviewerActorId) return false;
        if (review.claimedReviewerActorId !== expectedClaimedReviewerActorId) return false;
        this.reviews.set(reviewId, { ...review, requestedReviewerActorId: reviewerActorId, claimedReviewerActorId: undefined, claimedAt: undefined });
        return true;
      },
      compareAndSetReviewDecision: async (review, expectedClaimedReviewerActorId) => {
        const current = this.reviews.get(review.id);
        if (!current || current.state !== "pending" || current.claimedReviewerActorId !== expectedClaimedReviewerActorId) return false;
        this.reviews.set(review.id, clone(review));
        return true;
      },
      getActivePolicy: async (actorId, capability, kind) => {
        const matches = [...this.policies.values()].filter(x => x.actorId === actorId && x.capability === capability && (!x.documentKind || x.documentKind === kind));
        const latest = matches.sort((a, b) => b.version - a.version)[0];
        return latest?.active ? clone(latest) : undefined;
      },
      insertPolicy: async value => { this.policies.set(value.id, clone(value)); },
      nextPolicyVersion: async () => ++this.policyVersion,
      getPolicyById: async id => clone(this.policies.get(id)),
      getIdempotency: async (scope, actor, key) => clone(this.idempotency.get(idemKey(scope, actor, key))),
      insertIdempotency: async value => { const key = idemKey(value.scope, value.actorId, value.key); if (this.idempotency.has(key)) throw new SharedSpecDomainError("CONFLICT", "Idempotency key already exists"); this.idempotency.set(key, clone(value)); },
    };
  }
}