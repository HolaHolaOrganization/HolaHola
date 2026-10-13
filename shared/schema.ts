import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, real, bigint, bigserial, index, unique, uniqueIndex, jsonb, pgEnum, date, doublePrecision, check, customType, foreignKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { RESOLUTION_TYPE_VALUES } from "./absence-types";
import type { ResolutionType } from "./absence-types";

// ===== Shared Spec Workspace ==================================================
// This is intentionally a portable PostgreSQL-only collaboration core. Actor
// IDs are application-owned strings; no hosting, runtime, or identity-provider
// identifiers are persisted here. "note" is a lightweight kind for fast,
// unreviewed cross-actor sharing (see shareDocument in shared-spec-core.ts);
// "design"/"architecture" documents use the full review/publish lifecycle.
export const SHARED_SPEC_DOCUMENT_KINDS = ['design', 'architecture', 'note'] as const;
export type SharedSpecDocumentKind = typeof SHARED_SPEC_DOCUMENT_KINDS[number];

export const SHARED_SPEC_DOCUMENT_STATES = [
  'draft',
  'ready_for_review',
  'approved',
  'published',
  'merged',
  'archived',
] as const;
export type SharedSpecDocumentState = typeof SHARED_SPEC_DOCUMENT_STATES[number];

export const SHARED_SPEC_REVIEW_STATES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type SharedSpecReviewState = typeof SHARED_SPEC_REVIEW_STATES[number];

export const SHARED_SPEC_PUBLICATION_STATES = [
  'requested',
  'creating',
  'open',
  'merged',
  'closed',
  'conflict',
  'failed',
] as const;
export type SharedSpecPublicationState = typeof SHARED_SPEC_PUBLICATION_STATES[number];

export const SHARED_SPEC_REVIEWER_CAPABILITIES = ['reviewer', 'policy_admin'] as const;
export type SharedSpecReviewerCapability = typeof SHARED_SPEC_REVIEWER_CAPABILITIES[number];

export const sharedSpecDocumentKindEnum = pgEnum('shared_spec_document_kind', SHARED_SPEC_DOCUMENT_KINDS);
export const sharedSpecDocumentStateEnum = pgEnum('shared_spec_document_state', SHARED_SPEC_DOCUMENT_STATES);
export const sharedSpecReviewStateEnum = pgEnum('shared_spec_review_state', SHARED_SPEC_REVIEW_STATES);
export const sharedSpecPublicationStateEnum = pgEnum('shared_spec_publication_state', SHARED_SPEC_PUBLICATION_STATES);
export const sharedSpecReviewerCapabilityEnum = pgEnum('shared_spec_reviewer_capability', SHARED_SPEC_REVIEWER_CAPABILITIES);

export type SharedSpecEvidenceReference = {
  type: string;
  provider: string;
  identifier: string;
  label?: string;
  digest?: string;
  metadata?: Record<string, unknown>;
};

export const sharedSpecDocuments = pgTable("shared_spec_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title", { length: 300 }).notNull(),
  summary: text("summary"),
  kind: sharedSpecDocumentKindEnum("kind").notNull(),
  // Set only at document creation (see CreateDocumentInput in
  // shared-spec-core.ts). When true, approving a revision writes the
  // markdown directly to canonicalPath and commits it instead of opening a
  // GitHub PR. There is no path to flip this on an existing document.
  liveInstructionDocument: boolean("live_instruction_document").notNull().default(false),
  canonicalRepository: varchar("canonical_repository", { length: 255 }).notNull(),
  canonicalPath: varchar("canonical_path", { length: 1024 }).notNull(),
  // The pointer is populated in the same transaction as the initial revision.
  // Its cyclic foreign key is added by the migration after both tables exist.
  currentRevisionId: varchar("current_revision_id"),
  state: sharedSpecDocumentStateEnum("state").notNull().default('draft'),
  creatorActor: varchar("creator_actor", { length: 80 }).notNull(),
  publishedRevisionId: varchar("published_revision_id"),
  mergedRevisionId: varchar("merged_revision_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_shared_spec_documents_active_destination")
    .on(table.canonicalRepository, table.canonicalPath)
    .where(sql`${table.state} <> 'archived'`),
  index("idx_shared_spec_documents_current_revision").on(table.currentRevisionId),
  index("idx_shared_spec_documents_state_updated").on(table.state, table.updatedAt),
  check("shared_spec_documents_repository_nonempty", sql`length(trim(${table.canonicalRepository})) > 0`),
  check("shared_spec_documents_path_nonempty", sql`length(trim(${table.canonicalPath})) > 0`),
]);

export const sharedSpecRevisions = pgTable("shared_spec_revisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => sharedSpecDocuments.id),
  parentRevisionId: varchar("parent_revision_id").references((): any => sharedSpecRevisions.id),
  markdown: text("markdown").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  authorActor: varchar("author_actor", { length: 80 }).notNull(),
  // Request provenance stays with the immutable row; retry authority lives in
  // shared_spec_idempotency_records, not in a process-local cache.
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_shared_spec_revisions_idempotency")
    .on(table.documentId, table.authorActor, table.idempotencyKey),
  index("idx_shared_spec_revisions_document_created").on(table.documentId, table.createdAt),
  index("idx_shared_spec_revisions_parent").on(table.parentRevisionId),
  check("shared_spec_revisions_markdown_nonempty", sql`length(${table.markdown}) > 0`),
  check("shared_spec_revisions_content_hash_sha256", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("shared_spec_revisions_request_digest_sha256", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
]);

// Policies are versioned facts. The migration adds a database guard so old
// eligibility decisions cannot be rewritten when an actor is later disabled.
export const sharedSpecReviewerPolicies = pgTable("shared_spec_reviewer_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Versions are allocated by the transaction repository and never reused.
  version: integer("version").notNull(),
  actorId: varchar("actor_id", { length: 80 }).notNull(),
  capability: sharedSpecReviewerCapabilityEnum("capability").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  documentKind: sharedSpecDocumentKindEnum("document_kind"),
  boundary: varchar("boundary", { length: 120 }),
  provenance: text("provenance").notNull(),
  effectiveAt: timestamp("effective_at").notNull().defaultNow(),
  createdByActor: varchar("created_by_actor", { length: 80 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_shared_spec_reviewer_policies_version").on(table.version),
  index("idx_shared_spec_reviewer_policies_lookup")
    .on(table.actorId, table.capability, table.effectiveAt),
  index("idx_shared_spec_reviewer_policies_effective").on(table.effectiveAt),
  check("shared_spec_reviewer_policies_version_positive", sql`${table.version} > 0`),
  check("shared_spec_reviewer_policies_actor_nonempty", sql`length(trim(${table.actorId})) > 0`),
  check("shared_spec_reviewer_policies_provenance_nonempty", sql`length(trim(${table.provenance})) > 0`),
]);

export const sharedSpecReviews = pgTable("shared_spec_reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => sharedSpecDocuments.id),
  revisionId: varchar("revision_id").notNull().references(() => sharedSpecRevisions.id),
  revisionContentHash: varchar("revision_content_hash", { length: 64 }).notNull(),
  requestedByActor: varchar("requested_by_actor", { length: 80 }).notNull(),
  requestedReviewerActor: varchar("requested_reviewer_actor", { length: 80 }),
  claimedReviewerActor: varchar("claimed_reviewer_actor", { length: 80 }),
  decisionActor: varchar("decision_actor", { length: 80 }),
  // Immutable eligibility evidence is copied at decision time, rather than
  // being re-resolved against policy that may later change.
  decisionPolicyVersionId: varchar("decision_policy_version_id")
    .references(() => sharedSpecReviewerPolicies.id),
  decisionPolicyVersion: integer("decision_policy_version"),
  decisionPolicyActorId: varchar("decision_policy_actor_id", { length: 80 }),
  decisionPolicyCapability: sharedSpecReviewerCapabilityEnum("decision_policy_capability"),
  decisionPolicyActive: boolean("decision_policy_active"),
  decisionPolicyDocumentKind: sharedSpecDocumentKindEnum("decision_policy_document_kind"),
  decisionPolicyEffectiveAt: timestamp("decision_policy_effective_at"),
  state: sharedSpecReviewStateEnum("state").notNull().default('pending'),
  decisionRationale: text("decision_rationale"),
  evidenceReferences: jsonb("evidence_references").$type<SharedSpecEvidenceReference[]>(),
  // The review request keeps its digest for auditability; the durable
  // idempotency ledger resolves retries across application processes.
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  claimedAt: timestamp("claimed_at"),
  decidedAt: timestamp("decided_at"),
  cancelledAt: timestamp("cancelled_at"),
}, (table) => [
  uniqueIndex("uq_shared_spec_reviews_revision").on(table.documentId, table.revisionId),
  uniqueIndex("uq_shared_spec_reviews_idempotency")
    .on(table.documentId, table.requestedByActor, table.idempotencyKey),
  index("idx_shared_spec_reviews_pending").on(table.state, table.requestedReviewerActor, table.createdAt),
  index("idx_shared_spec_reviews_revision").on(table.revisionId),
  check("shared_spec_reviews_content_hash_sha256", sql`${table.revisionContentHash} ~ '^[0-9a-f]{64}$'`),
  check("shared_spec_reviews_request_digest_sha256", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("shared_spec_reviews_decision_policy_snapshot", sql`
    (${table.decisionPolicyVersionId} IS NULL
      AND ${table.decisionPolicyVersion} IS NULL
      AND ${table.decisionPolicyActorId} IS NULL
      AND ${table.decisionPolicyCapability} IS NULL
      AND ${table.decisionPolicyActive} IS NULL
      AND ${table.decisionPolicyEffectiveAt} IS NULL)
    OR
    (${table.decisionPolicyVersionId} IS NOT NULL
      AND ${table.decisionPolicyVersion} > 0
      AND ${table.decisionPolicyActorId} IS NOT NULL
      AND ${table.decisionPolicyCapability} IS NOT NULL
      AND ${table.decisionPolicyActive} IS NOT NULL
      AND ${table.decisionPolicyEffectiveAt} IS NOT NULL)
  `),
]);

export const sharedSpecPublications = pgTable("shared_spec_publications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => sharedSpecDocuments.id),
  revisionId: varchar("revision_id").notNull().references(() => sharedSpecRevisions.id),
  reviewId: varchar("review_id").notNull().references(() => sharedSpecReviews.id),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  repository: varchar("repository", { length: 255 }).notNull(),
  baseRef: varchar("base_ref", { length: 255 }).notNull(),
  expectedBaseCommit: varchar("expected_base_commit", { length: 64 }).notNull(),
  destinationPath: varchar("destination_path", { length: 1024 }).notNull(),
  expectedDestinationBlobHash: varchar("expected_destination_blob_hash", { length: 64 }),
  expectedDestinationAbsent: boolean("expected_destination_absent").notNull().default(false),
  requestedByActor: varchar("requested_by_actor", { length: 80 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  branchName: varchar("branch_name", { length: 255 }),
  pullRequestNumber: integer("pull_request_number"),
  pullRequestUrl: text("pull_request_url"),
  state: sharedSpecPublicationStateEnum("state").notNull().default('requested'),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  openedAt: timestamp("opened_at"),
  mergedAt: timestamp("merged_at"),
  closedAt: timestamp("closed_at"),
}, (table) => [
  uniqueIndex("uq_shared_spec_publications_approved_revision")
    .on(table.documentId, table.revisionId, table.reviewId, table.contentHash),
  uniqueIndex("uq_shared_spec_publications_idempotency")
    .on(table.requestedByActor, table.idempotencyKey),
  index("idx_shared_spec_publications_state_updated").on(table.state, table.updatedAt),
  index("idx_shared_spec_publications_review").on(table.reviewId),
  check("shared_spec_publications_content_hash_sha256", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("shared_spec_publications_request_digest_sha256", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("shared_spec_publications_expected_base_commit_nonempty", sql`length(trim(${table.expectedBaseCommit})) > 0`),
  check("shared_spec_publications_destination_expectation", sql`(${table.expectedDestinationAbsent} AND ${table.expectedDestinationBlobHash} IS NULL) OR (NOT ${table.expectedDestinationAbsent} AND ${table.expectedDestinationBlobHash} IS NOT NULL)`),
  check("shared_spec_publications_destination_blob_hash_sha256", sql`${table.expectedDestinationBlobHash} IS NULL OR ${table.expectedDestinationBlobHash} ~ '^[0-9a-f]{64}$'`),
]);

export const sharedSpecPublicationAttempts = pgTable("shared_spec_publication_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  publicationId: varchar("publication_id").notNull().references(() => sharedSpecPublications.id),
  attemptNumber: integer("attempt_number").notNull(),
  operation: varchar("operation", { length: 80 }).notNull(),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  requestMetadata: jsonb("request_metadata"),
  responseMetadata: jsonb("response_metadata"),
  errorDetail: text("error_detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_shared_spec_publication_attempts_sequence")
    .on(table.publicationId, table.attemptNumber),
  index("idx_shared_spec_publication_attempts_publication_created")
    .on(table.publicationId, table.createdAt),
  check("shared_spec_publication_attempts_number_positive", sql`${table.attemptNumber} > 0`),
  check("shared_spec_publication_attempts_operation_nonempty", sql`length(trim(${table.operation})) > 0`),
  check("shared_spec_publication_attempts_outcome_nonempty", sql`length(trim(${table.outcome})) > 0`),
]);

// Mutation retries resolve through this durable ledger, never process-local
// memory. A reused key must match its original immutable request digest.
export const sharedSpecIdempotencyRecords = pgTable("shared_spec_idempotency_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scope: varchar("scope", { length: 255 }).notNull(),
  actorId: varchar("actor_id", { length: 80 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  resultType: varchar("result_type", { length: 40 }).notNull(),
  resultId: varchar("result_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_shared_spec_idempotency_records_scope_actor_key")
    .on(table.scope, table.actorId, table.idempotencyKey),
  index("idx_shared_spec_idempotency_records_created").on(table.createdAt),
  check("shared_spec_idempotency_records_scope_nonempty", sql`length(trim(${table.scope})) > 0`),
  check("shared_spec_idempotency_records_actor_nonempty", sql`length(trim(${table.actorId})) > 0`),
  check("shared_spec_idempotency_records_key_nonempty", sql`length(trim(${table.idempotencyKey})) > 0`),
  check("shared_spec_idempotency_records_request_digest_sha256", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("shared_spec_idempotency_records_result_type_nonempty", sql`length(trim(${table.resultType})) > 0`),
  check("shared_spec_idempotency_records_result_id_nonempty", sql`length(trim(${table.resultId})) > 0`),
]);

export const insertSharedSpecDocumentSchema = createInsertSchema(sharedSpecDocuments).omit({
  id: true, currentRevisionId: true, state: true, publishedRevisionId: true,
  mergedRevisionId: true, createdAt: true, updatedAt: true,
});
export type InsertSharedSpecDocument = z.infer<typeof insertSharedSpecDocumentSchema>;
export type SharedSpecDocument = typeof sharedSpecDocuments.$inferSelect;
export type SharedSpecRevision = typeof sharedSpecRevisions.$inferSelect;
export type SharedSpecReviewerPolicy = typeof sharedSpecReviewerPolicies.$inferSelect;
export type SharedSpecReview = typeof sharedSpecReviews.$inferSelect;
export type SharedSpecPublication = typeof sharedSpecPublications.$inferSelect;
export type SharedSpecPublicationAttempt = typeof sharedSpecPublicationAttempts.$inferSelect;
export type SharedSpecIdempotencyRecord = typeof sharedSpecIdempotencyRecords.$inferSelect;

// ===== Agent Memory (DB-canonical shared docs) =================================
// .agents/memory/MEMORY.md and every .agents/memory/<slug>.md file are generated
// projections of these three tables. No hat hand-edits those files directly --
// server/scripts/agent-memory-cli.ts is the only sanctioned writer. See
// docs/superpowers/specs/2026-09-21-shared-docs-db-canonical-design.md.

export const agentMemoryTopics = pgTable("agent_memory_topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Matches the filename .agents/memory/<slug>.md. A real (not just indexed)
  // unique constraint, not a standalone unique index -- agent_memory_entries
  // and agent_memory_topic_blocks reference it by foreign key.
  slug: varchar("slug", { length: 120 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("uq_agent_memory_topics_slug").on(table.slug),
  check("agent_memory_topics_slug_nonempty", sql`length(trim(${table.slug})) > 0`),
]);

export const agentMemoryEntries = pgTable("agent_memory_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  topicSlug: varchar("topic_slug", { length: 120 }).notNull()
    .references(() => agentMemoryTopics.slug),
  title: varchar("title", { length: 200 }).notNull(),
  // 300, not the ~200-character index-line guideline plus a little slack:
  // the real pre-migration MEMORY.md corpus already has hooks up to 243
  // characters (agents didn't always follow the soft guideline), and this
  // column must fit that history losslessly, not just new writes.
  hook: varchar("hook", { length: 300 }).notNull(),
  createdByActor: varchar("created_by_actor", { length: 80 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Optimistic-concurrency token for editEntry, same shape as shared-spec's
  // compare-and-swap: caller supplies the version it read; zero rows updated
  // means a stale write, never a silent overwrite.
  version: integer("version").notNull().default(1),
  deletedAt: timestamp("deleted_at"),
  deletedByActor: varchar("deleted_by_actor", { length: 80 }),
}, (table) => [
  index("idx_agent_memory_entries_topic").on(table.topicSlug),
  index("idx_agent_memory_entries_rendering").on(table.deletedAt, table.createdAt),
  check("agent_memory_entries_title_nonempty", sql`length(trim(${table.title})) > 0`),
  check("agent_memory_entries_hook_nonempty", sql`length(trim(${table.hook})) > 0`),
  check("agent_memory_entries_version_positive", sql`${table.version} > 0`),
  check("agent_memory_entries_delete_pairing", sql`(${table.deletedAt} IS NULL AND ${table.deletedByActor} IS NULL) OR (${table.deletedAt} IS NOT NULL AND ${table.deletedByActor} IS NOT NULL)`),
]);

export const agentMemoryTopicBlocks = pgTable("agent_memory_topic_blocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  topicSlug: varchar("topic_slug", { length: 120 }).notNull()
    .references(() => agentMemoryTopics.slug),
  // Sortable text key. A fresh append gets a key after the current max; an
  // insert-between computes a lexicographic midpoint between two neighbors.
  // No existing row's key is ever rewritten by another insert.
  orderKey: varchar("order_key", { length: 200 }).notNull(),
  heading: varchar("heading", { length: 200 }),
  bodyMarkdown: text("body_markdown").notNull(),
  authorActor: varchar("author_actor", { length: 80 }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  deletedByActor: varchar("deleted_by_actor", { length: 80 }),
}, (table) => [
  unique("uq_agent_memory_topic_blocks_order").on(table.topicSlug, table.orderKey),
  index("idx_agent_memory_topic_blocks_rendering")
    .on(table.topicSlug, table.deletedAt, table.orderKey),
  check("agent_memory_topic_blocks_order_key_nonempty", sql`length(trim(${table.orderKey})) > 0`),
  check("agent_memory_topic_blocks_body_nonempty", sql`length(${table.bodyMarkdown}) > 0`),
  check("agent_memory_topic_blocks_version_positive", sql`${table.version} > 0`),
  check("agent_memory_topic_blocks_delete_pairing", sql`(${table.deletedAt} IS NULL AND ${table.deletedByActor} IS NULL) OR (${table.deletedAt} IS NOT NULL AND ${table.deletedByActor} IS NOT NULL)`),
]);

export const insertAgentMemoryTopicSchema = createInsertSchema(agentMemoryTopics).omit({
  id: true, createdAt: true,
});
export const insertAgentMemoryEntrySchema = createInsertSchema(agentMemoryEntries).omit({
  id: true, createdAt: true, version: true, deletedAt: true, deletedByActor: true,
});
export const insertAgentMemoryTopicBlockSchema = createInsertSchema(agentMemoryTopicBlocks).omit({
  id: true, createdAt: true, updatedAt: true, version: true, deletedAt: true, deletedByActor: true,
});
export type InsertAgentMemoryTopic = z.infer<typeof insertAgentMemoryTopicSchema>;
export type InsertAgentMemoryEntry = z.infer<typeof insertAgentMemoryEntrySchema>;
export type InsertAgentMemoryTopicBlock = z.infer<typeof insertAgentMemoryTopicBlockSchema>;
export type AgentMemoryTopic = typeof agentMemoryTopics.$inferSelect;
export type AgentMemoryEntry = typeof agentMemoryEntries.$inferSelect;
export type AgentMemoryTopicBlock = typeof agentMemoryTopicBlocks.$inferSelect;

// ===== Enums =====

// Auth provider enum - distinguishes how user authenticates
// 'replit' kept permanently even after Replit auth is fully retired -- Postgres
// enums are awkward to shrink, and it remains a valid historical value for old rows.
export const authProviderEnum = pgEnum('auth_provider', ['replit', 'password', 'pending', 'google', 'github', 'apple']);

// Token type enum for password reset and invitations
export const authTokenTypeEnum = pgEnum('auth_token_type', ['password_reset', 'invitation']);

// User role enum for multi-role system
export const userRoleEnum = pgEnum('user_role', ['student', 'teacher', 'developer', 'admin']);

// Learning context enum - distinguishes self-directed vs class-directed learning
export const learningContextEnum = pgEnum('learning_context', ['self_directed', 'class_assigned']);

// Conversation type enum - distinguishes learning conversations from editor collaboration
export const conversationTypeEnum = pgEnum('conversation_type', ['learning', 'editor_collaboration', 'agent_session']);

// Syllabus completion status enum
export const syllabusStatusEnum = pgEnum('syllabus_status', ['not_started', 'in_progress', 'completed_early', 'completed_assigned', 'skipped']);

// Tutor freedom level enum - controls how strictly the AI follows curriculum vs allows exploration
// 1 = Guided: Strictly follows syllabus, redirects off-topic conversations
// 2 = Flexible Goals: Student can choose topics within lesson objectives (e.g., pick travel destination)
// 3 = Open Exploration: Student-led conversation, tutor suggests learning connections
// 4 = Free Conversation: Minimal structure, maximum practice, still tracks progress
// NOTE: Being deprecated in favor of Daniela's Compass time-aware system
export const tutorFreedomLevelEnum = pgEnum('tutor_freedom_level', ['guided', 'flexible_goals', 'open_exploration', 'free_conversation']);

// ===== Daniela's Compass Enums =====
// Time-aware tutoring system that gives tutors real-time context instead of preset flexibility levels

// Tutor session status - tracks the lifecycle of a tutoring session
export const tutorSessionStatusEnum = pgEnum('tutor_session_status', [
  'scheduled',     // Session planned but not started
  'active',        // Session currently in progress
  'paused',        // Session temporarily paused
  'completed',     // Session ended normally
  'abandoned'      // Session ended without proper wrap-up
]);

// Topic coverage status - tracks progress on individual topics within a session
export const topicCoverageStatusEnum = pgEnum('topic_coverage_status', [
  'pending',       // Topic not yet started
  'in_progress',   // Currently being covered
  'covered',       // Topic successfully covered
  'partial',       // Topic partially covered, needs follow-up
  'deferred',      // Topic explicitly moved to next session
  'skipped'        // Topic skipped (not needed or out of time)
]);

// Topic priority - distinguishes must-have vs nice-to-have objectives
export const topicPriorityEnum = pgEnum('topic_priority', [
  'must_have',     // Essential objective for this session
  'nice_to_have',  // Secondary objective if time permits
  'bonus'          // Extra content for fast learners
]);

// Legacy schema migrations tracking table
// (IMPORTANT) Preserved for backward compatibility - do not delete
export const schemaMigrations = pgTable("schema_migrations", {
  version: varchar("version").primaryKey(),
  name: varchar("name"),
  appliedAt: timestamp("applied_at").defaultNow(),
});

// Replit Auth Integration - Session storage table
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// Replit Auth Integration - User storage table with Stripe billing
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email"), // Case-insensitively unique when non-empty -- see idx_users_email_unique below
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  // Auth provider - how this user authenticates
  authProvider: authProviderEnum("auth_provider").default("replit"), // replit, password, pending (for invites)
  // User role for multi-role system
  role: userRoleEnum("role").default("student").notNull(), // student, teacher, developer, admin
  learningPathMode: varchar("learning_path_mode").default("open"), // open, structured
  // Developer testing override
  developerModel: varchar("developer_model"), // null (use tier-based), 'gpt-4o-mini', or 'gpt-4o' for developers/admins
  // Admin impersonation for support/debugging
  impersonatedUserId: varchar("impersonated_user_id"), // If admin is impersonating, this is the original admin's ID
  impersonatedBy: varchar("impersonated_by"), // The admin ID who initiated impersonation
  impersonationExpiresAt: timestamp("impersonation_expires_at"), // Impersonation session expiry
  // Test account flag - for developer testing without polluting production analytics
  isTestAccount: boolean("is_test_account").default(false), // True = test account (dev testing), sessions excluded from production analytics
  // Beta tester flag - for beta testers who get granted credits but data excluded from production analytics
  isBetaTester: boolean("is_beta_tester").default(false), // True = beta tester, sessions excluded from production analytics
  // Learning preferences
  targetLanguage: varchar("target_language"), // english, spanish, french, german, italian, portuguese, japanese, mandarin, korean
  nativeLanguage: varchar("native_language").default("english"), // Language for explanations
  difficultyLevel: varchar("difficulty_level"), // beginner, intermediate, advanced
  onboardingCompleted: boolean("onboarding_completed").default(false),
  // Tutor preference - allows students to choose male or female tutor voice/avatar
  tutorGender: varchar("tutor_gender").default("female"), // male, female - matches voice and avatar
  // DEPRECATED: assistantVoiceGender - now uses tutorGender as single source of truth for all voice preferences
  // Column retained for backwards compatibility; not exposed in API
  assistantVoiceGender: varchar("assistant_voice_gender").default("female"),
  // Tutor personality - baseline emotion style for the AI tutor
  tutorPersonality: varchar("tutor_personality").default("warm"), // warm, calm, energetic, professional
  // Tutor expressiveness - how much the AI deviates from baseline (1=subtle, 5=very expressive)
  tutorExpressiveness: integer("tutor_expressiveness").default(3), // 1-5 scale
  // Self-directed tutor flexibility - controls how structured vs free-form conversations are
  // For class-assigned learning, this is overridden by the class's tutorFreedomLevel setting
  selfDirectedFlexibility: tutorFreedomLevelEnum("self_directed_flexibility").default("flexible_goals"), // guided, flexible_goals, open_exploration, free_conversation
  // Placement assessment for self-directed learners - determines if user has completed quick assessment
  selfDirectedPlacementDone: boolean("self_directed_placement_done").default(false), // true = user has done placement chat
  // First meeting completed - Daniela has gotten to know this student (resonance anchor, fears, sparks)
  hasCompletedFirstMeeting: boolean("has_completed_first_meeting").default(false), // true = Daniela has done first meeting flow
  // ACTFL proficiency tracking (unified assessment system)
  actflLevel: varchar("actfl_level"), // novice_low, novice_mid, novice_high, intermediate_low, intermediate_mid, intermediate_high, advanced_low, advanced_mid, advanced_high, superior, distinguished
  actflAssessed: boolean("actfl_assessed").default(false), // true = AI-verified, false = cold-start hint from onboarding
  assessmentSource: varchar("assessment_source").default("onboarding_hint"), // onboarding_hint, ai_conversation, placement_test, teacher_override
  lastAssessmentDate: timestamp("last_assessment_date"), // When ACTFL level was last updated
  // Timezone for time-aware greetings (auto-detected from browser, handles traveling)
  timezone: varchar("timezone"), // IANA timezone (e.g., "America/Denver", "Asia/Tokyo")
  // Memory privacy settings - controls what personal facts Daniela can remember
  // Categories: life_event, personal_detail, goal, preference, relationship, travel, work, family, hobby
  memoryPrivacySettings: jsonb("memory_privacy_settings").$type<{
    enabled: boolean; // Master switch for memory extraction
    allowedCategories: string[]; // Categories user allows (empty = all allowed)
    blockedCategories: string[]; // Categories user blocks
    redactionRequested: boolean; // User requested deletion of all memories
    redactionRequestedAt?: string; // When redaction was requested
  }>().default({ enabled: true, allowedCategories: [], blockedCategories: [], redactionRequested: false }),
  // Stripe billing integration
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  subscriptionTier: varchar("subscription_tier").default("free"), // free, basic, pro, institutional
  subscriptionStatus: varchar("subscription_status").default("active"), // active, canceled, past_due, trialing
  // Usage tracking for cost analysis
  monthlyMessageCount: integer("monthly_message_count").default(0), // Voice messages sent this month
  monthlyMessageLimit: integer("monthly_message_limit").default(20), // 20 for free, unlimited for paid
  lastMessageResetDate: timestamp("last_message_reset_date").defaultNow(),
  totalConversations: integer("total_conversations").default(0),
  // Legal acceptance
  tosAcceptedAt: timestamp("tos_accepted_at"), // When user accepted Terms of Service (null = not yet accepted)
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Case-insensitive, partial (non-empty emails only) uniqueness -- the same
  // email must resolve to one account regardless of which auth provider
  // created it. Partial so multiple pending/system rows without an email
  // yet don't collide with each other or with NULL.
  uniqueIndex("idx_users_email_unique").on(sql`lower(${table.email})`).where(sql`${table.email} IS NOT NULL AND ${table.email} != ''`),
]);

export const updateUserPreferencesSchema = z.object({
  targetLanguage: z.string().optional(),
  nativeLanguage: z.string().optional(),
  difficultyLevel: z.string().optional(),
  onboardingCompleted: z.boolean().optional(),
  tutorGender: z.enum(['male', 'female', 'no_preference']).optional(),
  tutorPersonality: z.enum(['warm', 'calm', 'energetic', 'professional']).optional(),
  tutorExpressiveness: z.number().min(1).max(5).optional(),
  selfDirectedFlexibility: z.enum(['guided', 'flexible_goals', 'open_exploration', 'free_conversation']).optional(),
  selfDirectedPlacementDone: z.boolean().optional(),
  memoryPrivacySettings: z.object({
    enabled: z.boolean(),
    allowedCategories: z.array(z.string()),
    blockedCategories: z.array(z.string()),
    redactionRequested: z.boolean(),
    redactionRequestedAt: z.string().optional(),
  }).optional(),
});

// Memory privacy settings type for convenience
export type MemoryPrivacySettings = {
  enabled: boolean;
  allowedCategories: string[];
  blockedCategories: string[];
  redactionRequested: boolean;
  redactionRequestedAt?: string;
};

// Type for tutor freedom/flexibility levels
export type TutorFreedomLevel = 'guided' | 'flexible_goals' | 'open_exploration' | 'free_conversation';

export type UpdateUserPreferences = z.infer<typeof updateUserPreferencesSchema>;
export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

// ===== Password Auth Tables =====

// User credentials - stores password hashes for users with password auth
export const userCredentials = pgTable("user_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: varchar("password_hash").notNull(),
  passwordVersion: integer("password_version").notNull().default(1),
  requiresReset: boolean("requires_reset").notNull().default(false),
  lastPasswordChange: timestamp("last_password_change").defaultNow(),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_user_credentials_user_id").on(table.userId),
]);

export const insertUserCredentialsSchema = createInsertSchema(userCredentials).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUserCredentials = z.infer<typeof insertUserCredentialsSchema>;
export type UserCredentials = typeof userCredentials.$inferSelect;

// Auth tokens - for password reset and invitation links
export const authTokens = pgTable("auth_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar("token_hash").notNull(),
  tokenType: authTokenTypeEnum("token_type").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  metadata: jsonb("metadata"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_auth_tokens_user_id").on(table.userId),
  index("idx_auth_tokens_type").on(table.tokenType),
  index("idx_auth_tokens_expires").on(table.expiresAt),
]);

export const insertAuthTokenSchema = createInsertSchema(authTokens).omit({ id: true, createdAt: true });
export type InsertAuthToken = z.infer<typeof insertAuthTokenSchema>;
export type AuthToken = typeof authTokens.$inferSelect;

// Pending invitations - tracks teacher-initiated student invitations
export const pendingInvites = pgTable("pending_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").notNull(),
  role: userRoleEnum("role").notNull().default("student"),
  invitedBy: varchar("invited_by").notNull().references(() => users.id),
  classId: varchar("class_id"),
  tokenId: varchar("token_id").notNull().references(() => authTokens.id, { onDelete: 'cascade' }),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  initialCreditsSeconds: integer("initial_credits_seconds").default(0),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  acceptedUserId: varchar("accepted_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_pending_invites_email").on(table.email),
  index("idx_pending_invites_invited_by").on(table.invitedBy),
  index("idx_pending_invites_token").on(table.tokenId),
]);

export const insertPendingInviteSchema = createInsertSchema(pendingInvites).omit({ id: true, createdAt: true });
export type InsertPendingInvite = z.infer<typeof insertPendingInviteSchema>;
export type PendingInvite = typeof pendingInvites.$inferSelect;

// Schema for creating an invitation from admin UI
export const createInvitationSchema = z.object({
  email: z.string().email("Invalid email address"),
  firstName: z.string().min(1, "First name is required").optional(),
  lastName: z.string().optional(),
  role: z.enum(['student', 'teacher']).default('student'),
  classId: z.string().optional(),
  initialCreditsSeconds: z.number().min(0).default(0),
});
export type CreateInvitation = z.infer<typeof createInvitationSchema>;

// Schema for completing registration (setting password)
export const completeRegistrationSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});
export type CompleteRegistration = z.infer<typeof completeRegistrationSchema>;

// Schema for password reset request
export const passwordResetRequestSchema = z.object({
  email: z.string().email("Invalid email address"),
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

// Schema for setting new password
export const setNewPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});
export type SetNewPassword = z.infer<typeof setNewPasswordSchema>;

// Schema for password login
export const passwordLoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type PasswordLogin = z.infer<typeof passwordLoginSchema>;

// Schema for real self-serve registration (no invitation required)
export const passwordRegisterSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});
export type PasswordRegister = z.infer<typeof passwordRegisterSchema>;

// Per-language self-directed preferences
// Allows users to have different flexibility settings per language
// (e.g., Guided for Spanish class, Free Conversation for Italian self-directed)
export const userLanguagePreferences = pgTable("user_language_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: varchar("language").notNull(), // spanish, french, german, italian, etc.
  // Self-directed flexibility for this specific language
  selfDirectedFlexibility: tutorFreedomLevelEnum("self_directed_flexibility").default("flexible_goals"),
  // Whether user has completed placement assessment for this language
  selfDirectedPlacementDone: boolean("self_directed_placement_done").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_user_language_prefs_user_lang").on(table.userId, table.language),
]);

export const insertUserLanguagePreferencesSchema = createInsertSchema(userLanguagePreferences).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUserLanguagePreferences = z.infer<typeof insertUserLanguagePreferencesSchema>;
export type UserLanguagePreferences = typeof userLanguagePreferences.$inferSelect;

// Schema for updating per-language preferences
export const updateLanguagePreferencesSchema = z.object({
  language: z.string(),
  selfDirectedFlexibility: z.enum(['guided', 'flexible_goals', 'open_exploration', 'free_conversation']).optional(),
  selfDirectedPlacementDone: z.boolean().optional(),
});
export type UpdateLanguagePreferences = z.infer<typeof updateLanguagePreferencesSchema>;

// Tutor role enum - distinguishes main tutors from practice partner assistants and support agents
export const tutorRoleEnum = pgEnum("tutor_role", ["tutor", "assistant", "support", "alden"]);

// Pedagogical focus options for tutor personas
export const pedagogicalFocusEnum = pgEnum("pedagogical_focus", [
  "grammar",          // Focus on grammar rules and structure
  "fluency",          // Focus on natural conversation flow
  "pronunciation",    // Focus on accent and pronunciation
  "culture",          // Focus on cultural context and nuances
  "vocabulary",       // Focus on vocabulary building
  "mixed"             // Balanced approach
]);

// Teaching style options for tutor personas
export const teachingStyleEnum = pgEnum("teaching_style", [
  "structured",       // Formal, lesson-plan based
  "conversational",   // Natural, chat-like teaching
  "drill_focused",    // Repetition and practice heavy
  "adaptive",         // Adjusts based on student response
  "socratic"          // Question-based discovery learning
]);

// Error tolerance levels
export const errorToleranceEnum = pgEnum("error_tolerance", [
  "high",             // Gentle corrections, prioritizes flow
  "medium",           // Balanced correction approach
  "low"               // Immediate, thorough corrections
]);

// Vocabulary level for teaching
export const vocabularyLevelEnum = pgEnum("vocabulary_level", [
  "beginner_friendly", // Simple words, lots of context
  "intermediate",      // Standard vocabulary
  "advanced",          // Sophisticated vocabulary
  "academic"           // Formal, technical vocabulary
]);

// Tutor Voices - Admin-configurable voices per language with male/female options
// This replaces hardcoded voice mappings and allows admin voice audition/assignment
// Now includes both main tutors (Cartesia) and practice partner assistants (Google TTS)
// Extended with Pedagogical Persona Registry for teaching style metadata
export const tutorVoices = pgTable("tutor_voices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  language: varchar("language").notNull(), // spanish, french, german, etc.
  gender: varchar("gender").notNull(), // male, female
  role: tutorRoleEnum("role").notNull().default("tutor"), // tutor = main conversation partner, assistant = drill practice partner
  provider: varchar("provider").notNull().default("cartesia"), // cartesia, google
  voiceId: varchar("voice_id").notNull(), // Cartesia voice ID or Google voice name
  voiceName: varchar("voice_name").notNull(), // Display name for admin UI (e.g., "Daniela - Warmhearted Teacher")
  languageCode: varchar("language_code").notNull(), // Language code for TTS (e.g., "es", "en")
  speakingRate: real("speaking_rate").notNull().default(0.9), // Speed: 0.7 (slow) to 1.3 (fast), 0.9 = natural
  personality: varchar("personality").notNull().default("warm"), // warm, calm, energetic, professional
  expressiveness: integer("expressiveness").notNull().default(3), // 1-5 scale
  emotion: varchar("emotion").notNull().default("friendly"), // Default emotion for TTS
  isActive: boolean("is_active").notNull().default(true), // Enable/disable voice without deleting
  
  // ========== ELEVENLABS VOICE SETTINGS ==========
  elStability: real("el_stability").default(0.5), // 0.0-1.0, voice consistency (lower = more expressive)
  elSimilarityBoost: real("el_similarity_boost").default(0.75), // 0.0-1.0, adherence to original voice
  elStyle: real("el_style").default(0.0), // 0.0-1.0, style exaggeration
  elSpeakerBoost: boolean("el_speaker_boost").default(true), // Subtle voice similarity enhancement
  
  // ========== GEMINI TTS SETTINGS ==========
  geminiLanguageCode: varchar("gemini_language_code"), // BCP-47 accent variant (e.g., 'es-MX', 'en-GB', 'pt-BR')
  modelVariant: varchar("model_variant"), // null = applies to all GL model variants; specific = per-model voice preference (e.g. 'gemini-3.1-flash-live-preview')
  
  // ========== GOOGLE CLOUD TTS SETTINGS ==========
  googlePitch: real("google_pitch").default(0), // -10.0 to +10.0 semitones
  googleVolumeGainDb: real("google_volume_gain_db").default(0), // -10.0 to +10.0 dB
  
  // ========== PEDAGOGICAL PERSONA REGISTRY ==========
  // Teaching profile metadata for each tutor - shapes AI behavior beyond just voice
  pedagogicalFocus: pedagogicalFocusEnum("pedagogical_focus").default("mixed"), // Primary teaching emphasis
  teachingStyle: teachingStyleEnum("teaching_style").default("conversational"), // How lessons are delivered
  errorTolerance: errorToleranceEnum("error_tolerance").default("medium"), // Correction approach
  vocabularyLevel: vocabularyLevelEnum("vocabulary_level").default("intermediate"), // Language complexity
  personalityTraits: text("personality_traits"), // Detailed personality description (e.g., "patient, encouraging, uses humor")
  scenarioStrengths: text("scenario_strengths"), // Best use cases (e.g., "roleplay, casual conversation, grammar drills")
  teachingPhilosophy: text("teaching_philosophy"), // Core teaching belief (e.g., "Learning should be fun and stress-free")
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_tutor_voices_language_gender").on(table.language, table.gender),
  index("idx_tutor_voices_role").on(table.role),
]);

export const insertTutorVoiceSchema = createInsertSchema(tutorVoices).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTutorVoice = z.infer<typeof insertTutorVoiceSchema>;
export type TutorVoice = typeof tutorVoices.$inferSelect;

export const conversations = pgTable("conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  ownerEmail: text("owner_email"), // Cross-environment identifier - same email across dev/prod
  language: text("language").notNull(), // Target language being learned
  nativeLanguage: text("native_language").notNull().default("english"), // Student's native language (for explanations)
  difficulty: text("difficulty").notNull(),
  topic: text("topic"),
  title: text("title"), // Thread name for multiple conversations
  messageCount: integer("message_count").notNull().default(0),
  duration: integer("duration").notNull().default(0),
  isOnboarding: boolean("is_onboarding").notNull().default(false),
  onboardingStep: text("onboarding_step"),
  userName: text("user_name"), // Kept for backward compatibility
  // Performance tracking for auto-difficulty adjustment
  successfulMessages: integer("successful_messages").notNull().default(0), // Messages with score >= 60
  totalAssessedMessages: integer("total_assessed_messages").notNull().default(0), // Total user messages assessed
  // ACTFL standards tracking
  actflLevel: text("actfl_level"), // novice_low, novice_mid, novice_high, intermediate_low, intermediate_mid, intermediate_high, advanced_low, advanced_mid, advanced_high, superior, distinguished
  // Organization features (Phase 1)
  isStarred: boolean("is_starred").notNull().default(false), // User can star/favorite conversations
  // Institutional features - Class/Course assignment
  classId: varchar("class_id"), // Links to teacherClasses table for filtering by class (e.g., "Spanish 101")
  learningContext: learningContextEnum("learning_context").default("self_directed"), // self_directed or class_assigned
  // Conversation type - distinguishes learning from editor collaboration
  conversationType: conversationTypeEnum("conversation_type").default("learning"), // learning, editor_collaboration
  textbookLessonId: text("textbook_lesson_id"), // Lesson ID when conversation starts from a textbook chapter
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastMessageAt: timestamp("last_message_at"), // When the most recent message was sent (nullable for old rows)
}, (table) => [
  index("idx_conversations_user_id").on(table.userId),
  index("idx_conversations_user_language").on(table.userId, table.language),
  index("idx_conversations_class").on(table.classId),
  index("idx_conversations_type").on(table.conversationType),
  index("idx_conversations_owner_email").on(table.ownerEmail),
]);

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  // Voice conversation text display - shows foreign language text on screen for reading reinforcement
  targetLanguageText: text("target_language_text"), // Foreign language portion to display during voice chat
  // Subtitle sequence for showing multiple subtitles (encouragement + teaching word)
  subtitlesJson: text("subtitles_json"), // JSON array of {text: string, duration?: number} - shows sequentially
  // Word-level timing data for synchronized subtitle highlighting (karaoke-style)
  wordTimingsJson: text("word_timings_json"), // JSON array of {word: string, startTime: number, endTime: number}
  // AI tutor multimedia - images from stock sources or AI-generated
  mediaJson: text("media_json"), // JSON array of media items {type: "stock"|"ai_generated", query?, prompt?, url?, ...}
  // Performance tracking (for user messages only)
  performanceScore: integer("performance_score"), // 0-100: AI assessment of response quality
  // ACTFL standards tracking - auto-tagged by AI based on language complexity
  actflLevel: text("actfl_level"), // novice_low, novice_mid, etc. - AI detects complexity of message content
  // Background enrichment status for voice chat optimization
  enrichmentStatus: text("enrichment_status"), // null (complete), "pending", "processing", "failed" - used for split response in voice chat
  // GL thought content — Daniela's internal deliberation for this turn (from includeThoughts:true).
  // Only populated for role='assistant' rows from voice sessions. Persisted so Daniela can read
  // her own past thinking via the Archive.
  thoughtContent: text("thought_content"),
  // Full-text search vector (auto-populated by database trigger)
  searchVector: text("search_vector"),
  // Legacy embedding column (preserved for data continuity - may contain vector embeddings)
  embedding: text("embedding"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_messages_conversation_id").on(table.conversationId),
]);

// Word type enum for grammar classification
export const wordTypeEnum = pgEnum('word_type', ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'article', 'other']);

export const vocabularyWords = pgTable("vocabulary_words", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  word: text("word").notNull(),
  translation: text("translation").notNull(),
  example: text("example").notNull(),
  pronunciation: text("pronunciation").notNull(),
  difficulty: text("difficulty").notNull(),
  // ACTFL standards tracking
  actflLevel: text("actfl_level"), // novice_low, novice_mid, etc.
  // Organization features (Phase 2) - Link to source conversation
  sourceConversationId: varchar("source_conversation_id").references(() => conversations.id), // Where this word was learned
  sourceMessageId: varchar("source_message_id"), // Optional: specific message that introduced the word
  // Institutional features - Class/Course assignment
  classId: varchar("class_id"), // Links to teacherClasses table for filtering by class (e.g., "Spanish 101")
  // Grammar classification (Phase 3) - For filtering flashcards by grammar type
  wordType: wordTypeEnum("word_type"), // noun, verb, adjective, etc.
  verbTense: text("verb_tense"), // present, past, future, conditional, etc. (for verbs)
  verbMood: text("verb_mood"), // indicative, subjunctive, imperative (for verbs)
  verbPerson: text("verb_person"), // 1st_singular, 3rd_plural, etc. (for verbs)
  nounGender: text("noun_gender"), // masculine, feminine, neutral (for nouns)
  nounNumber: text("noun_number"), // singular, plural (for nouns)
  grammarNotes: text("grammar_notes"), // Additional grammar info (e.g., "irregular", "reflexive")
  // Spaced repetition fields
  nextReviewDate: timestamp("next_review_date").notNull().defaultNow(),
  correctCount: integer("correct_count").notNull().default(0), // Lifetime correct reviews
  incorrectCount: integer("incorrect_count").notNull().default(0), // Lifetime incorrect reviews
  repetition: integer("repetition").notNull().default(0), // Consecutive correct reviews (resets on failure)
  easeFactor: real("ease_factor").notNull().default(2.5), // SM-2 algorithm default
  interval: integer("interval").notNull().default(1), // Days until next review
  createdAt: timestamp("created_at").notNull().defaultNow(), // Track when word was learned
}, (table) => [
  index("idx_vocabulary_user_id").on(table.userId),
  index("idx_vocabulary_source_conversation").on(table.sourceConversationId),
  index("idx_vocabulary_word_type").on(table.wordType),
  index("idx_vocabulary_class").on(table.classId),
  uniqueIndex("idx_vocabulary_unique_word").on(table.userId, table.word, table.language),
]);

export const grammarExercises = pgTable("grammar_exercises", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  language: text("language").notNull(),
  difficulty: text("difficulty").notNull(),
  // ACTFL standards tracking
  actflLevel: text("actfl_level"), // novice_low, novice_mid, etc.
  // Link to grammar competency for organized practice
  competencyId: varchar("competency_id"), // References grammarCompetencies
  question: text("question").notNull(),
  options: text("options").array().notNull(),
  correctAnswer: integer("correct_answer").notNull(),
  explanation: text("explanation").notNull(),
  // Exercise type for varied practice
  exerciseType: text("exercise_type").default("multiple_choice"), // multiple_choice, fill_blank, error_correction, conjugation
  // Hint for micro-coaching
  hint: text("hint"), // Optional hint for struggling learners
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_grammar_exercises_language").on(table.language),
  index("idx_grammar_exercises_competency").on(table.competencyId),
]);

// Grammar category enum for organizing competencies
export const grammarCategoryEnum = pgEnum('grammar_category', [
  'verb_tense',        // Present, Past, Future, Conditional, etc.
  'verb_mood',         // Indicative, Subjunctive, Imperative
  'verb_aspect',       // Simple, Progressive, Perfect
  'verb_type',         // Regular, Irregular, Reflexive, Modal
  'noun_agreement',    // Gender, Number
  'pronoun',           // Subject, Object, Reflexive, Possessive
  'adjective',         // Agreement, Placement, Comparison
  'adverb',            // Formation, Placement
  'preposition',       // Usage, Contractions
  'article',           // Definite, Indefinite, Partitive
  'sentence_structure', // Word order, Questions, Negation
  'clause',            // Relative, Conditional, Temporal
]);

// Master grammar competencies - ACTFL-aligned grammar forms
export const grammarCompetencies = pgTable("grammar_competencies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Core identification
  name: text("name").notNull(), // e.g., "Present Tense - Regular Verbs"
  slug: text("slug").notNull(), // e.g., "present-tense-regular"
  language: text("language").notNull(), // spanish, french, etc.
  // Categorization
  category: grammarCategoryEnum("category").notNull(), // verb_tense, verb_mood, etc.
  subcategory: text("subcategory"), // e.g., "regular", "irregular", "stem-changing"
  // ACTFL alignment
  actflLevel: text("actfl_level").notNull(), // novice_low through distinguished
  actflLevelNumeric: integer("actfl_level_numeric").notNull(), // 1-11 for sorting
  // Content
  description: text("description").notNull(), // Full explanation for Grammar Hub
  shortExplanation: text("short_explanation").notNull(), // 1-2 sentences for micro-coaching
  examples: text("examples").array().notNull(), // Example sentences with translations
  commonMistakes: text("common_mistakes").array(), // Typical errors to watch for
  // Teaching metadata
  prerequisiteIds: text("prerequisite_ids").array(), // Competencies that should be learned first
  difficultyScore: integer("difficulty_score").notNull().default(1), // 1-10 relative difficulty
  estimatedMinutes: integer("estimated_minutes").notNull().default(15), // Time to master
  // Applicable verb/noun info (for conjugation drills)
  paradigmJson: text("paradigm_json"), // JSON with full conjugation/declension table
  // Status
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_grammar_competencies_language").on(table.language),
  index("idx_grammar_competencies_actfl").on(table.actflLevel),
  index("idx_grammar_competencies_category").on(table.category),
  index("idx_grammar_competencies_slug").on(table.slug),
]);

// User progress on grammar competencies
export const userGrammarProgress = pgTable("user_grammar_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  competencyId: varchar("competency_id").notNull(), // References grammarCompetencies
  language: text("language").notNull(),
  // Mastery tracking
  masteryLevel: integer("mastery_level").notNull().default(0), // 0-100 percentage
  exercisesCompleted: integer("exercises_completed").notNull().default(0),
  exercisesCorrect: integer("exercises_correct").notNull().default(0),
  // Spaced repetition for grammar
  nextReviewDate: timestamp("next_review_date"),
  repetition: integer("repetition").notNull().default(0), // Consecutive correct (SM-2)
  easeFactor: real("ease_factor").notNull().default(2.5),
  interval: integer("interval").notNull().default(1), // Days until next review
  // Voice session usage
  usedInConversation: boolean("used_in_conversation").notNull().default(false),
  conversationUsageCount: integer("conversation_usage_count").notNull().default(0),
  lastConversationUse: timestamp("last_conversation_use"),
  // Timestamps
  firstPracticed: timestamp("first_practiced"),
  lastPracticed: timestamp("last_practiced"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_user_grammar_progress_user").on(table.userId),
  index("idx_user_grammar_progress_user_lang").on(table.userId, table.language),
  index("idx_user_grammar_progress_competency").on(table.competencyId),
]);

// Grammar errors detected during voice sessions (telemetry)
export const grammarErrors = pgTable("grammar_errors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  conversationId: varchar("conversation_id").references(() => conversations.id),
  messageId: varchar("message_id"), // References messages.id
  language: text("language").notNull(),
  // Error details
  competencyId: varchar("competency_id"), // References grammarCompetencies if identifiable
  errorCategory: grammarCategoryEnum("error_category"), // Which grammar area
  errorType: text("error_type").notNull(), // Specific error type (e.g., "verb_conjugation", "gender_agreement")
  // Context
  userText: text("user_text").notNull(), // What the user said/wrote
  correctedText: text("corrected_text"), // Correct version
  explanation: text("explanation"), // Why it was wrong
  // Tracking
  wasAddressed: boolean("was_addressed").notNull().default(false), // Did we show micro-coaching?
  wasPracticed: boolean("was_practiced").notNull().default(false), // Did user complete follow-up drill?
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_grammar_errors_user").on(table.userId),
  index("idx_grammar_errors_user_lang").on(table.userId, table.language),
  index("idx_grammar_errors_competency").on(table.competencyId),
  index("idx_grammar_errors_conversation").on(table.conversationId),
]);

// Grammar assignments for teachers
export const grammarAssignments = pgTable("grammar_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classId: varchar("class_id").notNull(), // References teacherClasses
  teacherId: varchar("teacher_id").notNull().references(() => users.id),
  // Assignment details
  title: text("title").notNull(),
  description: text("description"),
  competencyIds: text("competency_ids").array().notNull(), // Grammar topics to cover
  // Requirements
  minExercises: integer("min_exercises").notNull().default(10), // Minimum exercises to complete
  minScore: integer("min_score").notNull().default(70), // Minimum % to pass
  // Schedule
  dueDate: timestamp("due_date"),
  isPublished: boolean("is_published").notNull().default(false),
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_grammar_assignments_class").on(table.classId),
  index("idx_grammar_assignments_teacher").on(table.teacherId),
]);

// Student submissions for grammar assignments
export const grammarAssignmentSubmissions = pgTable("grammar_assignment_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assignmentId: varchar("assignment_id").notNull(), // References grammarAssignments
  studentId: varchar("student_id").notNull().references(() => users.id),
  // Progress
  exercisesCompleted: integer("exercises_completed").notNull().default(0),
  exercisesCorrect: integer("exercises_correct").notNull().default(0),
  score: integer("score"), // Final percentage (null if incomplete)
  // Status
  status: text("status").notNull().default("not_started"), // not_started, in_progress, completed, graded
  submittedAt: timestamp("submitted_at"),
  gradedAt: timestamp("graded_at"),
  teacherFeedback: text("teacher_feedback"),
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_grammar_submissions_assignment").on(table.assignmentId),
  index("idx_grammar_submissions_student").on(table.studentId),
]);

// Insert and Select schemas for grammar tables
export const insertGrammarExerciseSchema = createInsertSchema(grammarExercises).omit({
  id: true,
  createdAt: true,
});

export const insertGrammarCompetencySchema = createInsertSchema(grammarCompetencies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserGrammarProgressSchema = createInsertSchema(userGrammarProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGrammarErrorSchema = createInsertSchema(grammarErrors).omit({
  id: true,
  createdAt: true,
});

export const insertGrammarAssignmentSchema = createInsertSchema(grammarAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGrammarAssignmentSubmissionSchema = createInsertSchema(grammarAssignmentSubmissions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertGrammarExercise = z.infer<typeof insertGrammarExerciseSchema>;
export type GrammarExercise = typeof grammarExercises.$inferSelect;

export type InsertGrammarCompetency = z.infer<typeof insertGrammarCompetencySchema>;
export type GrammarCompetency = typeof grammarCompetencies.$inferSelect;

export type InsertUserGrammarProgress = z.infer<typeof insertUserGrammarProgressSchema>;
export type UserGrammarProgress = typeof userGrammarProgress.$inferSelect;

export type InsertGrammarError = z.infer<typeof insertGrammarErrorSchema>;
export type GrammarError = typeof grammarErrors.$inferSelect;

export type InsertGrammarAssignment = z.infer<typeof insertGrammarAssignmentSchema>;
export type GrammarAssignment = typeof grammarAssignments.$inferSelect;

export type InsertGrammarAssignmentSubmission = z.infer<typeof insertGrammarAssignmentSubmissionSchema>;
export type GrammarAssignmentSubmission = typeof grammarAssignmentSubmissions.$inferSelect;

export const userProgress = pgTable("user_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  wordsLearned: integer("words_learned").notNull().default(0),
  practiceMinutes: integer("practice_minutes").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  totalPracticeDays: integer("total_practice_days").notNull().default(0),
  lastPracticeDate: timestamp("last_practice_date"),
  // Auto-difficulty tracking
  suggestedDifficulty: text("suggested_difficulty"), // AI-recommended difficulty level
  lastDifficultyAdjustment: timestamp("last_difficulty_adjustment"), // When difficulty was last changed
  // ACTFL proficiency tracking
  currentActflLevel: text("current_actfl_level"), // Current assessed ACTFL level for this language
  lastActflAssessment: timestamp("last_actfl_assessment"), // When ACTFL level was last updated
});

// ACTFL FACT Criteria Progress Tracking
// Tracks evidence-based progression aligned with ACTFL 2024 Guidelines
export const actflProgress = pgTable("actfl_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  
  // F - Functions: Communication tasks student can handle
  tasksCompleted: text("tasks_completed").array().default(sql`ARRAY[]::text[]`), // e.g., ["greetings", "ordering_food", "describing_family"]
  tasksTotal: integer("tasks_total").notNull().default(0), // Total unique tasks mastered
  
  // A - Accuracy: Linguistic control (pronunciation, grammar, vocab)
  avgPronunciationConfidence: real("avg_pronunciation_confidence").default(0), // From Deepgram (0-1 scale)
  totalVoiceMessages: integer("total_voice_messages").default(0),
  grammarScore: real("grammar_score").default(0), // From AI assessment (0-1 scale)
  vocabularyScore: real("vocabulary_score").default(0), // From AI assessment (0-1 scale)
  
  // C - Context: Range of situations and topics
  topicsCovered: text("topics_covered").array().default(sql`ARRAY[]::text[]`), // e.g., ["family", "school", "hobbies", "travel"]
  topicsTotal: integer("topics_total").notNull().default(0), // Total unique topics covered
  
  // T - Text Type: Discourse complexity level
  textType: text("text_type").default('words'), // "words", "sentences", "paragraphs", "multi_paragraph"
  avgMessageLength: real("avg_message_length").default(0), // Average words per user message
  longestMessageLength: integer("longest_message_length").default(0), // Longest coherent message
  
  // Time-based progression (ACTFL requires sustained performance)
  practiceHours: real("practice_hours").default(0), // Total practice time in hours
  messagesAtCurrentLevel: integer("messages_at_current_level").default(0), // Messages since last level change
  daysAtCurrentLevel: integer("days_at_current_level").default(0), // Days at current ACTFL level
  lastAdvancement: timestamp("last_advancement"), // Last ACTFL level change
  
  // Overall assessment
  currentActflLevel: text("current_actfl_level").default('novice_low'),
  readyForAdvancement: boolean("ready_for_advancement").default(false), // AI recommendation
  advancementReason: text("advancement_reason"), // Why student is/isn't ready
  operationReceipts: jsonb("operation_receipts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_actfl_progress_user_language").on(table.userId, table.language),
]);

export const insertActflProgressSchema = createInsertSchema(actflProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertActflProgress = z.infer<typeof insertActflProgressSchema>;
export type ActflProgress = typeof actflProgress.$inferSelect;

export const progressHistory = pgTable("progress_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  date: timestamp("date").notNull(),
  wordsLearned: integer("words_learned").notNull().default(0),
  practiceMinutes: integer("practice_minutes").notNull().default(0),
  conversationsCount: integer("conversations_count").notNull().default(0),
});

export const pronunciationScores = pgTable("pronunciation_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  messageId: varchar("message_id").notNull().references(() => messages.id),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  transcribedText: text("transcribed_text").notNull(),
  targetPhrase: text("target_phrase"),
  score: integer("score").notNull(), // 0-100
  feedback: text("feedback").notNull(),
  phoneticIssues: text("phonetic_issues").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Topic type enum: subject (travel, food), grammar (past tense, subjunctive), function (asking questions)
export const topicTypeEnum = pgEnum('topic_type', ['subject', 'grammar', 'function']);

export const topics = pgTable("topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description").notNull(),
  topicType: topicTypeEnum("topic_type").notNull().default('subject'), // subject, grammar, or function
  category: text("category").notNull(), // e.g., "Daily Life", "Travel", "Business" OR "Verb Tenses", "Mood"
  icon: text("icon").notNull(), // Lucide icon name
  samplePhrases: text("sample_phrases").array().notNull(),
  difficulty: text("difficulty"), // Optional difficulty recommendation
  // Grammar-specific fields
  grammarConcept: text("grammar_concept"), // For grammar topics: "past_tense", "subjunctive", etc.
  applicableLanguages: text("applicable_languages").array(), // Languages this grammar applies to (null = all)
  actflLevelRange: text("actfl_level_range"), // e.g., "novice_high-intermediate_mid"
}, (table) => [
  index("idx_topics_type").on(table.topicType),
  index("idx_topics_category").on(table.category),
]);

export const culturalTips = pgTable("cultural_tips", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  language: text("language").notNull(),
  category: text("category").notNull(), // e.g., "Greetings", "Dining", "Social Norms", "Customs", "Holidays"
  title: text("title").notNull(),
  content: text("content").notNull(),
  context: text("context").notNull(), // When/where this applies
  relatedTopics: text("related_topics").array(), // Optional topic associations
  icon: text("icon").notNull(), // Lucide icon name
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ===== Dual-Path Learning System: Institutional Features =====

// ACTFL Can-Do Statements for progress tracking
export const canDoStatements = pgTable("can_do_statements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  language: text("language").notNull(), // spanish, french, etc.
  actflLevel: text("actfl_level").notNull(), // novice_low, novice_mid, etc.
  category: text("category").notNull(), // interpersonal, interpretive, presentational
  mode: text("mode"), // speaking, listening, reading, writing
  statement: text("statement").notNull(), // "I can greet someone and introduce myself"
  description: text("description"), // Additional context/examples
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Student progress on Can-Do statements
export const studentCanDoProgress = pgTable("student_can_do_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  canDoStatementId: varchar("can_do_statement_id").notNull().references(() => canDoStatements.id),
  selfAssessed: boolean("self_assessed").default(false), // Student marked as achieved
  teacherVerified: boolean("teacher_verified").default(false), // Teacher confirmed
  aiDetected: boolean("ai_detected").default(false), // AI detected evidence in conversations
  dateAchieved: timestamp("date_achieved"),
  evidenceConversationId: varchar("evidence_conversation_id").references(() => conversations.id), // Conversation that demonstrated this skill
  notes: text("notes"), // Teacher notes
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Structured curriculum paths (e.g., "Spanish 1 - High School")
export const curriculumPaths = pgTable("curriculum_paths", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // "Spanish 1 - High School"
  description: text("description").notNull(),
  language: text("language").notNull(),
  targetAudience: text("target_audience"), // "High School", "Middle School", "Adult Learners"
  startLevel: text("start_level").notNull(), // novice_low
  endLevel: text("end_level").notNull(), // intermediate_low
  estimatedHours: integer("estimated_hours"), // 150 hours
  isPublished: boolean("is_published").default(false),
  createdBy: varchar("created_by").references(() => users.id), // Teacher who created it
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Units within a curriculum path
export const curriculumUnits = pgTable("curriculum_units", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  curriculumPathId: varchar("curriculum_path_id").notNull().references(() => curriculumPaths.id),
  name: text("name").notNull(), // "Unit 1: Greetings & Introductions"
  description: text("description").notNull(),
  orderIndex: integer("order_index").notNull(), // Order within the path
  actflLevel: text("actfl_level"), // Target proficiency level for this unit
  culturalTheme: text("cultural_theme"), // Cultural focus of the unit
  estimatedHours: integer("estimated_hours"),
  // === Teacher Promises (Commitments) ===
  // JSON object containing teacher's promises for this unit
  // Structure: { promises: string[], reviewPoints: string[], prerequisites: string[] }
  commitments: jsonb("commitments"), // Teacher promises block: what students can expect
  chapterType: text("chapter_type"), // Chapter intro type: 'greetings', 'numbers', 'family', 'daily', etc.
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Requirement tier enum - for bundle content classification (must be defined before curriculumLessons)
export const requirementTierEnum = pgEnum('requirement_tier', [
  'required',           // Core lesson content, must complete to progress
  'recommended',        // Suggested reinforcement (drills, extra practice), can skip
  'optional_premium',   // Extra help for students who want more (may require fee)
]);

// Individual lessons within a unit
export const curriculumLessons = pgTable("curriculum_lessons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  curriculumUnitId: varchar("curriculum_unit_id").notNull().references(() => curriculumUnits.id),
  name: text("name").notNull(), // "Lesson 1: Basic Greetings"
  description: text("description").notNull(),
  orderIndex: integer("order_index").notNull(), // Order within the unit
  lessonType: text("lesson_type").notNull(), // conversation, vocabulary, grammar, cultural_exploration, drill
  actflLevel: text("actfl_level"),
  // Prerequisite lesson (drill-first learning flow)
  prerequisiteLessonId: varchar("prerequisite_lesson_id"), // Must complete this lesson first (e.g., drill before conversation)
  // Lesson content
  conversationTopic: text("conversation_topic"), // Topic for AI conversation
  conversationPrompt: text("conversation_prompt"), // System prompt for this lesson
  // Learning objectives
  objectives: text("objectives").array(), // What students should be able to do
  estimatedMinutes: integer("estimated_minutes"), // Expected completion time
  // Competency mapping - links to topic slugs for automatic coverage detection
  requiredTopics: text("required_topics").array(), // e.g., ["greetings-introductions", "making-requests"]
  requiredVocabulary: text("required_vocabulary").array(), // Key words that must be mastered
  requiredGrammar: text("required_grammar").array(), // Grammar concepts (e.g., "present_tense", "noun-adjective-agreement")
  minPronunciationScore: real("min_pronunciation_score"), // Minimum pronunciation confidence (0-1)
  // === Bundle System Fields ===
  // Content classification for required/recommended/optional content
  requirementTier: requirementTierEnum("requirement_tier").default("required"), // required | recommended | optional_premium
  // Bundle grouping - links related lessons (e.g., conversation + matching drill)
  bundleId: varchar("bundle_id"), // Optional: groups lessons into cohesive learning bundles
  // Linked drill lesson - for conversation↔drill pairing
  linkedDrillLessonId: varchar("linked_drill_lesson_id"), // Links a conversation lesson to its paired drill lesson
  // Cover image for this lesson (displayed in textbook chapter view)
  imageUrl: text("image_url"),
  // Enrichment data (AI-generated supplemental content)
  enrichmentNotes: jsonb("enrichment_notes"),
  enrichedAt: timestamp("enriched_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ===== Drill Lesson Content =====

// Drill item types enum
export const drillItemTypeEnum = pgEnum('drill_item_type', [
  'listen_repeat',      // Hear audio, repeat back
  'number_dictation',   // Hear number, type it
  'translate_speak',    // See text, speak translation
  'matching',           // Match audio to images/text
  'fill_blank',         // Fill in missing word
]);

// Individual drill items within a drill lesson
export const curriculumDrillItems = pgTable("curriculum_drill_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id, { onDelete: 'cascade' }),
  itemType: drillItemTypeEnum("item_type").notNull(),
  orderIndex: integer("order_index").notNull(), // Order within the drill
  // Content
  prompt: text("prompt").notNull(),           // What to display (e.g., "43" for number dictation)
  targetText: text("target_text").notNull(),  // Correct answer/what to say (e.g., "cuarenta y tres")
  targetLanguage: text("target_language").notNull(), // Language code for TTS
  // Audio - gender-specific for user preference support
  audioUrl: text("audio_url"),                // Legacy/fallback audio URL
  audioDurationMs: integer("audio_duration_ms"), // Legacy/fallback duration
  audioUrlFemale: text("audio_url_female"),   // Female voice audio URL
  audioDurationMsFemale: integer("audio_duration_ms_female"),
  audioUrlMale: text("audio_url_male"),       // Male voice audio URL
  audioDurationMsMale: integer("audio_duration_ms_male"),
  // Optional hints and alternatives
  hints: text("hints").array(),               // Progressive hints
  acceptableAlternatives: text("acceptable_alternatives").array(), // Other correct answers
  // Native-language translations for non-English learners
  // e.g., { "fr": "Bonjour", "de": "Hallo" } — prompt field already contains English
  translations: jsonb("translations").$type<Record<string, string>>(),
  // Metadata
  difficulty: integer("difficulty").default(1), // 1-5 difficulty rating
  tags: text("tags").array(),                 // e.g., ["numbers", "1-100", "tens"]
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_drill_items_lesson").on(table.lessonId),
  index("idx_drill_items_type").on(table.itemType),
]);

// User progress on individual drill items
export const userDrillProgress = pgTable("user_drill_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  drillItemId: varchar("drill_item_id").notNull().references(() => curriculumDrillItems.id, { onDelete: 'cascade' }),
  // Learning source tracking - which class context this review happened in
  classId: varchar("class_id"), // Links to teacherClasses table (null = self-directed)
  // Progress tracking
  attempts: integer("attempts").default(0),
  correctCount: integer("correct_count").default(0),
  lastScore: real("last_score"),              // Most recent attempt score (0-1)
  bestScore: real("best_score"),              // Best score achieved (0-1)
  averageScore: real("average_score"),        // Running average
  // Mastery status
  mastered: boolean("mastered").default(false),
  masteredAt: timestamp("mastered_at"),
  // Spaced repetition
  nextReviewAt: timestamp("next_review_at"),  // When to review again
  reviewInterval: integer("review_interval").default(1), // Days until next review
  // Timing
  lastAttemptedAt: timestamp("last_attempted_at"),
  totalTimeSpentMs: integer("total_time_spent_ms").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_drill_progress_user").on(table.userId),
  index("idx_drill_progress_item").on(table.drillItemId),
  index("idx_drill_progress_mastery").on(table.mastered),
  index("idx_drill_progress_review").on(table.nextReviewAt),
]);

// Self-directed practice sessions (for Practice Explorer feature)
export const selfPracticeSessions = pgTable("self_practice_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id, { onDelete: 'cascade' }),
  targetLanguage: text("target_language").notNull(),
  // Session status
  status: text("status").notNull().default("in_progress"), // in_progress, completed, abandoned
  // Progress tracking
  totalItems: integer("total_items").notNull().default(0),
  completedItems: integer("completed_items").notNull().default(0),
  correctItems: integer("correct_items").notNull().default(0),
  averageScore: real("average_score"),
  // Timing
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  totalTimeSpentMs: integer("total_time_spent_ms").default(0),
  // Metadata
  drillItemIds: text("drill_item_ids").array(), // Which drill items were included
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_self_practice_user").on(table.userId),
  index("idx_self_practice_lesson").on(table.lessonId),
  index("idx_self_practice_status").on(table.status),
  index("idx_self_practice_language").on(table.targetLanguage),
]);

// Audio library for caching TTS-generated audio
export const audioLibrary = pgTable("audio_library", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contentType: text("content_type").notNull(), // 'drill', 'vocabulary', 'pronunciation'
  textHash: varchar("text_hash", { length: 64 }).notNull(), // SHA256 of text + language + voice + speed
  text: text("text").notNull(), // Original text for debugging/display
  language: varchar("language", { length: 10 }).notNull(), // Language code (e.g., 'spanish', 'fr')
  voiceId: varchar("voice_id", { length: 100 }), // TTS voice identifier
  speed: text("speed").notNull().default("normal"), // 'slow', 'normal', 'fast'
  audioUrl: text("audio_url").notNull(), // Base64 data URL or storage URL
  durationMs: integer("duration_ms"), // Audio duration in milliseconds
  sourceId: varchar("source_id"), // drill_item_id if applicable
  hitCount: integer("hit_count").notNull().default(0), // Cache hit counter
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_audio_library_hash").on(table.textHash),
  index("idx_audio_library_language").on(table.language),
  index("idx_audio_library_source").on(table.sourceId),
  index("idx_audio_library_content_type").on(table.contentType),
]);

// Class types for categorizing classes (ACTFL-Led, Executive, Travel, etc.)
export const classTypes = pgTable("class_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(), // "ACTFL-Led Classes", "Executive/Business", etc.
  description: text("description"), // Longer description for marketing
  slug: varchar("slug").notNull().unique(), // URL-friendly identifier
  icon: varchar("icon"), // Lucide icon name for UI
  displayOrder: integer("display_order").default(0), // For sorting in UI
  isPreset: boolean("is_preset").default(false), // True for system-defined types
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Institutional hour packages for classes (tracks purchased allocations)
export const classHourPackages = pgTable("class_hour_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // "Basic 10-Hour Package", "Standard 20-Hour Package", "Premium 30-Hour Package"
  hoursPerStudent: integer("hours_per_student").notNull(), // Hours allocated per enrolled student
  totalPurchasedHours: integer("total_purchased_hours"), // Total hours purchased for this package (if bulk)
  usedHours: integer("used_hours").default(0), // Total hours used across all allocations
  pricePerStudent: integer("price_per_student"), // Price in cents per student (e.g., 5000 = $50)
  purchasedAt: timestamp("purchased_at").defaultNow(),
  expiresAt: timestamp("expires_at"), // When this package expires
  purchaserId: varchar("purchaser_id").references(() => users.id), // Teacher, admin, or institution
  status: varchar("status").default("active"), // active, expired, exhausted
  stripeSubscriptionId: varchar("stripe_subscription_id"), // For Stripe linkage
  metadata: text("metadata"), // JSON for additional contract details
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Teacher classes (for structured path)
export const teacherClasses = pgTable("teacher_classes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: varchar("teacher_id").notNull().references(() => users.id),
  createdById: varchar("created_by_id").references(() => users.id), // Track who created this (teacher or admin)
  name: text("name").notNull(), // "Spanish 1 - Period 3"
  description: text("description"),
  language: text("language").notNull(),
  curriculumPathId: varchar("curriculum_path_id").references(() => curriculumPaths.id), // Optional: link to structured curriculum
  joinCode: varchar("join_code").unique().notNull(), // 6-digit code for students to join
  isActive: boolean("is_active").default(true),
  isPublicCatalogue: boolean("is_public_catalogue").default(false), // If true, class is visible in public catalogue and allows self-enrollment
  // Class type and featured status for marketing catalogue
  classTypeId: varchar("class_type_id").references(() => classTypes.id), // Primary class type category
  isFeatured: boolean("is_featured").default(false), // If true, class appears in featured section
  featuredOrder: integer("featured_order"), // Order in featured carousel (lower = first)
  // Tutor behavior settings
  tutorFreedomLevel: tutorFreedomLevelEnum("tutor_freedom_level").default("flexible_goals"), // How strictly tutor follows curriculum
  // Class-level ACTFL expectations for unified assessment
  // expectedActflMin: Where students are assumed to start (used for initial tutor assumptions)
  // targetActflLevel: Where students should end up (class goal)
  expectedActflMin: varchar("expected_actfl_min"), // Starting assumption (e.g., novice_low for Spanish 1)
  targetActflLevel: varchar("target_actfl_level"), // Goal proficiency level (e.g., novice_high for Spanish 1)
  classLevel: integer("class_level").default(1), // Class difficulty tier (1=beginner, 2=intermediate, 3=advanced, 4=superior)
  requiresPlacementCheck: boolean("requires_placement_check").default(false), // If true, new enrollees get adaptive placement
  hoursPerStudent: integer("hours_per_student"), // Legacy: base hours allocated (moved to classHourPackages)
  hourPackageId: varchar("hour_package_id").references(() => classHourPackages.id), // Link to purchased hour package
  hoursPerStudentOverride: integer("hours_per_student_override"), // Optional per-class override
  // === Teacher Promises (Commitments) ===
  // JSON object containing class-level teacher promises
  // Structure: { promises: string[], reviewPolicy: string, supportHours: string }
  commitments: jsonb("commitments"), // Class-level teacher promises: what students can expect from this class
  subjectSyllabusId: varchar("subject_syllabus_id"), // For academic subject classes (links to subject_syllabi.subject)
  isAcademicClass: boolean("is_academic_class").default(false), // True for OpenStax-style content classes
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Class enrollment (students in classes)
export const classEnrollments = pgTable("class_enrollments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classId: varchar("class_id").notNull().references(() => teacherClasses.id),
  studentId: varchar("student_id").notNull().references(() => users.id),
  enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
  isActive: boolean("is_active").default(true),
  // Placement check for Level 2+ classes
  placementChecked: boolean("placement_checked").default(false), // true = placement assessment completed
  placementActflResult: varchar("placement_actfl_result"), // ACTFL level determined by placement assessment
  placementDelta: integer("placement_delta"), // Difference between self-reported and assessed (positive = overestimated)
  placementDate: timestamp("placement_date"), // When placement was completed
  // Hour allocation for this enrollment
  allocatedSeconds: integer("allocated_seconds").default(0), // Total hours allocated (in seconds, e.g., 36000 = 10 hrs)
  usedSeconds: integer("used_seconds").default(0), // Hours used so far
  // Pacing status for falling-behind warnings
  paceStatus: varchar("pace_status").default("on_track"), // on_track, ahead, behind, critical
  expectedProgressPercent: real("expected_progress_percent"), // Where student should be based on time elapsed
  actualProgressPercent: real("actual_progress_percent"), // Where student actually is
}, (table) => [
  index("idx_class_enrollments_student").on(table.studentId),
  index("idx_class_enrollments_class").on(table.classId),
]);

// ===== Class-Specific Curriculum (Teacher's Customizable Copy) =====

// Class-specific units (cloned from templates or custom-created by teacher)
export const classCurriculumUnits = pgTable("class_curriculum_units", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classId: varchar("class_id").notNull().references(() => teacherClasses.id),
  sourceUnitId: varchar("source_unit_id").references(() => curriculumUnits.id), // Original template unit (null if custom)
  name: text("name").notNull(),
  description: text("description").notNull(),
  orderIndex: integer("order_index").notNull(), // Order within the class
  actflLevel: text("actfl_level"), // Target proficiency level
  culturalTheme: text("cultural_theme"),
  estimatedHours: integer("estimated_hours"),
  commitments: jsonb("commitments"), // Unit commitments/objectives for brain map display
  isCustom: boolean("is_custom").default(false), // true if teacher created this unit
  isRemoved: boolean("is_removed").default(false), // soft delete for cloned units
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_class_curriculum_units_class").on(table.classId),
]);

// Class-specific lessons (cloned from templates or custom-created by teacher)
export const classCurriculumLessons = pgTable("class_curriculum_lessons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classUnitId: varchar("class_unit_id").notNull().references(() => classCurriculumUnits.id),
  sourceLessonId: varchar("source_lesson_id").references(() => curriculumLessons.id), // Original template lesson (null if custom)
  name: text("name").notNull(),
  description: text("description").notNull(),
  orderIndex: integer("order_index").notNull(), // Order within the unit
  lessonType: text("lesson_type").notNull(), // conversation, vocabulary, grammar, cultural_exploration, drill
  actflLevel: text("actfl_level"),
  // Bundle fields for lesson organization
  requirementTier: text("requirement_tier").default("required"), // required, recommended, optional_premium
  bundleId: varchar("bundle_id"), // Groups lessons that should be completed together
  linkedDrillLessonId: varchar("linked_drill_lesson_id"), // For conversation lessons, links to prerequisite drill
  // Prerequisite lesson (drill-first learning flow)
  prerequisiteLessonId: varchar("prerequisite_lesson_id"), // Must complete this lesson first (refers to class lesson id)
  // Lesson content
  conversationTopic: text("conversation_topic"),
  conversationPrompt: text("conversation_prompt"),
  // Learning objectives
  objectives: text("objectives").array(),
  estimatedMinutes: integer("estimated_minutes"),
  // Competency mapping
  requiredTopics: text("required_topics").array(),
  requiredVocabulary: text("required_vocabulary").array(),
  requiredGrammar: text("required_grammar").array(),
  minPronunciationScore: real("min_pronunciation_score"),
  // Teacher customization flags
  isCustom: boolean("is_custom").default(false), // true if teacher created this lesson
  isRemoved: boolean("is_removed").default(false), // soft delete for cloned lessons
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_class_curriculum_lessons_unit").on(table.classUnitId),
]);

// Teacher assignments
export const assignments = pgTable("assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classId: varchar("class_id").notNull().references(() => teacherClasses.id),
  teacherId: varchar("teacher_id").notNull().references(() => users.id),
  title: text("title").notNull(), // "Week 1: Greetings Practice"
  description: text("description"),
  assignmentType: text("assignment_type").notNull(), // conversation, vocabulary_review, grammar_exercise, curriculum_lesson
  // Assignment content
  curriculumLessonId: varchar("curriculum_lesson_id").references(() => curriculumLessons.id), // Link to curriculum lesson
  conversationTopic: text("conversation_topic"), // For conversation assignments
  targetMinutes: integer("target_minutes"), // Expected practice time
  targetMessageCount: integer("target_message_count"), // For conversation practice
  // Deadlines
  dueDate: timestamp("due_date"),
  isPublished: boolean("is_published").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Student assignment submissions
export const assignmentSubmissions = pgTable("assignment_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assignmentId: varchar("assignment_id").notNull().references(() => assignments.id),
  studentId: varchar("student_id").notNull().references(() => users.id),
  conversationId: varchar("conversation_id").references(() => conversations.id), // Conversation for this assignment
  status: text("status").default("not_started"), // not_started, in_progress, submitted, graded
  // Completion tracking
  minutesCompleted: integer("minutes_completed").default(0),
  messagesCompleted: integer("messages_completed").default(0),
  vocabularyMastered: integer("vocabulary_mastered").default(0),
  // Grading
  teacherScore: integer("teacher_score"), // 0-100
  teacherFeedback: text("teacher_feedback"),
  aiScore: integer("ai_score"), // Auto-calculated based on performance
  submittedAt: timestamp("submitted_at"),
  gradedAt: timestamp("graded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Syllabus progress - tracks lesson completion per student with organic vs assigned completion
export const syllabusProgress = pgTable("syllabus_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull().references(() => users.id),
  classId: varchar("class_id").notNull().references(() => teacherClasses.id),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id),
  // Completion status
  status: syllabusStatusEnum("status").default("not_started"), // not_started, in_progress, completed_early, completed_assigned, skipped
  // Evidence of completion
  evidenceConversationId: varchar("evidence_conversation_id").references(() => conversations.id), // Conversation that covered this lesson
  evidenceType: text("evidence_type"), // organic_conversation, assigned_practice, quick_review
  // Competency scores at time of completion
  topicsCoveredCount: integer("topics_covered_count").default(0), // How many required topics were covered
  vocabularyMastered: integer("vocabulary_mastered").default(0), // How many required words were mastered
  grammarScore: real("grammar_score"), // Grammar accuracy during completion (0-1)
  pronunciationScore: real("pronunciation_score"), // Avg pronunciation confidence (0-1)
  // Tutor verification
  tutorVerified: boolean("tutor_verified").default(false), // Did AI tutor confirm competency?
  tutorNotes: text("tutor_notes"), // AI assessment notes
  // Timing
  actualMinutes: integer("actual_minutes"), // Actual time spent on this lesson in minutes
  completedAt: timestamp("completed_at"),
  scheduledDate: timestamp("scheduled_date"), // When this lesson was supposed to be done (per syllabus)
  daysAhead: integer("days_ahead"), // Positive = completed early, negative = late
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_syllabus_progress_student").on(table.studentId),
  index("idx_syllabus_progress_class").on(table.classId),
  index("idx_syllabus_progress_lesson").on(table.lessonId),
  index("idx_syllabus_progress_status").on(table.status),
]);

// Topic competency status enum - what Daniela observed
export const topicCompetencyStatusEnum = pgEnum('topic_competency_status', ['demonstrated', 'needs_review', 'struggling']);

// Topic competency observations - Daniela's real-time observations of student topic mastery
// Used by SYLLABUS_PROGRESS command to track emergent learning during conversations
export const topicCompetencyObservations = pgTable("topic_competency_observations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  conversationId: varchar("conversation_id").references(() => conversations.id),
  classId: varchar("class_id").references(() => teacherClasses.id),
  language: varchar("language").notNull(),
  topicName: text("topic_name").notNull(),
  matchedTopicId: varchar("matched_topic_id").references(() => topics.id),
  status: topicCompetencyStatusEnum("status").notNull(),
  evidence: text("evidence").notNull(),
  observedAt: timestamp("observed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_topic_competency_user").on(table.userId),
  index("idx_topic_competency_language").on(table.language),
  index("idx_topic_competency_class").on(table.classId),
  index("idx_topic_competency_topic").on(table.topicName),
  index("idx_topic_competency_status").on(table.status),
]);

// ===== Daniela Recommendation Queue =====
// Persistent recommendations from Daniela (or system) for student follow-up between sessions
// Tracks what Daniela suggests for remediation, reinforcement, or acceleration

// Recommendation rationale enum - why this was recommended
export const recommendationRationaleEnum = pgEnum('recommendation_rationale', [
  'remediate',    // Address weakness from previous session
  'reinforce',    // Practice recently learned content
  'accelerate',   // Student is ahead, offer advanced content
]);

// Recommendation creator enum - who created this recommendation
export const recommendationCreatorEnum = pgEnum('recommendation_creator', [
  'daniela',      // Created by Daniela during session
  'system',       // Created by automated system (e.g., time-based triggers)
]);

// Daniela's recommendation queue
export const danielaRecommendations = pgTable("daniela_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  language: varchar("language").notNull(), // Language context for this recommendation
  classId: varchar("class_id").references(() => teacherClasses.id), // Optional class context
  // Recommendation details
  recommendationType: varchar("recommendation_type").notNull(), // lesson, drill, vocabulary, conversation_topic
  rationale: recommendationRationaleEnum("rationale").notNull(), // Why was this recommended?
  createdBy: recommendationCreatorEnum("created_by").notNull().default("daniela"), // Who created it?
  // Content reference
  lessonId: varchar("lesson_id").references(() => curriculumLessons.id), // Optional: specific lesson
  drillId: varchar("drill_id"), // Optional: specific drill (future reference)
  topicSlug: varchar("topic_slug"), // Optional: topic area
  vocabularyWords: text("vocabulary_words").array(), // Optional: specific words to practice
  // Context and messaging
  title: text("title").notNull(), // Short title for display
  description: text("description"), // Why Daniela recommends this
  priority: integer("priority").default(1), // 1-5, higher = more urgent
  // Queue management
  snoozedUntil: timestamp("snoozed_until"), // User can snooze recommendations
  completedAt: timestamp("completed_at"), // When recommendation was completed
  dismissedAt: timestamp("dismissed_at"), // When user dismissed without completing
  // Evidence of completion
  evidenceConversationId: varchar("evidence_conversation_id").references(() => conversations.id),
  // Timestamps
  sourceConversationId: varchar("source_conversation_id").references(() => conversations.id), // Where Daniela made this observation
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_daniela_recommendations_user").on(table.userId),
  index("idx_daniela_recommendations_language").on(table.language),
  index("idx_daniela_recommendations_class").on(table.classId),
  index("idx_daniela_recommendations_completed").on(table.completedAt),
  index("idx_daniela_recommendations_snoozed").on(table.snoozedUntil),
]);

export const insertDanielaRecommendationSchema = createInsertSchema(danielaRecommendations).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true 
});
export type InsertDanielaRecommendation = z.infer<typeof insertDanielaRecommendationSchema>;
export type DanielaRecommendation = typeof danielaRecommendations.$inferSelect;

// ===== Student Tier Signals =====
// Soft signals from students indicating their preference for content tier
// NOT auto-applied - Daniela/teacher reviews and decides whether to adjust

export const studentTierSignals = pgTable("student_tier_signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id), // Which lesson they're signaling about
  classId: varchar("class_id").references(() => teacherClasses.id), // Optional class context
  // Signal details
  requestedTier: requirementTierEnum("requested_tier").notNull(), // What tier do they want?
  currentTier: requirementTierEnum("current_tier"), // What tier is it currently? (snapshot)
  reason: text("reason"), // Optional: why they want this change
  // Review status
  reviewedAt: timestamp("reviewed_at"), // When teacher/Daniela reviewed
  reviewedBy: varchar("reviewed_by"), // "daniela" or teacher user ID
  reviewDecision: varchar("review_decision"), // approved, denied, deferred
  reviewNotes: text("review_notes"), // Notes from reviewer
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_student_tier_signals_user").on(table.userId),
  index("idx_student_tier_signals_lesson").on(table.lessonId),
  index("idx_student_tier_signals_class").on(table.classId),
  index("idx_student_tier_signals_pending").on(table.reviewedAt),
]);

export const insertStudentTierSignalSchema = createInsertSchema(studentTierSignals).omit({ 
  id: true, 
  createdAt: true 
});
export type InsertStudentTierSignal = z.infer<typeof insertStudentTierSignalSchema>;
export type StudentTierSignal = typeof studentTierSignals.$inferSelect;

// ===== Usage Tracking & Credit System =====

// Entitlement type enum - how credits were earned
export const entitlementTypeEnum = pgEnum('entitlement_type', ['class_allocation', 'purchase', 'bonus', 'trial']);

// Environment origin — which server created a record (development or production)
export const environmentOriginEnum = pgEnum('environment_origin', [
  'development',
  'production'
]);

// Voice session status enum
export const voiceSessionStatusEnum = pgEnum('voice_session_status', ['active', 'completed', 'abandoned', 'error']);

// Tutor mode enum - distinguishes main tutor from assistant tutor sessions
export const tutorModeEnum = pgEnum('tutor_mode', ['main', 'assistant']);

// Voice sessions - tracks each tutoring session with timing and exchange data
export const voiceSessions = pgTable("voice_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  conversationId: varchar("conversation_id"), // FK constraint already exists in DB - removed from schema to prevent duplicate during deploy
  // Session timing
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  durationSeconds: integer("duration_seconds").default(0), // Total session time
  // Exchange tracking
  exchangeCount: integer("exchange_count").default(0), // Number of back-and-forth turns
  studentSpeakingSeconds: integer("student_speaking_seconds").default(0),
  tutorSpeakingSeconds: integer("tutor_speaking_seconds").default(0),
  // Cost tracking (for internal analytics)
  ttsCharacters: integer("tts_characters").default(0), // Characters sent to TTS
  sttSeconds: integer("stt_seconds").default(0), // Seconds of STT processing
  llmInputTokens: integer("llm_input_tokens").default(0), // Actual Gemini input tokens (from usageMetadata)
  llmOutputTokens: integer("llm_output_tokens").default(0), // Actual Gemini output tokens (from usageMetadata)
  // Session metadata
  language: varchar("language"),
  status: voiceSessionStatusEnum("status").default("active"),
  // Tutor mode - distinguishes main tutor (Daniela) from assistant tutor (Aris) sessions
  tutorMode: tutorModeEnum("tutor_mode").default("main"),
  // Class context (if enrolled)
  classId: varchar("class_id").references(() => teacherClasses.id),
  // Test session flag - sessions from test accounts excluded from production analytics
  isTestSession: boolean("is_test_session").default(false),
  // Environment tracking - which server created this session
  environment: environmentOriginEnum("environment"),
  // Placement assessment persistence — survives browser disconnect/reconnect within the same DB session
  assessmentActive: boolean("assessment_active").default(false),
  assessmentTurnCount: integer("assessment_turn_count").default(0),
  // Rubric string stored so GL system prompt can be re-injected on reconnect (fixes "Amnesia" problem)
  assessmentRubric: text("assessment_rubric"),
  // Archive Guardian metrics — written at session end, queried by AldenWatch
  guardianFires: integer("guardian_fires"),
  guardianHardWalls: integer("guardian_hard_walls"),
  guardianHeard: integer("guardian_heard"),
  guardianMissed: integer("guardian_missed"),
  guardianCarryForward: integer("guardian_carry_forward"),
  // Returning-student signal — set when autoResolveAbsenceNudgeOnReturn fires at session start.
  // Lets the founder view confirm the warm-greeting fired for a given session.
  hadAbsenceReturn: boolean("had_absence_return").default(false),
  absenceReturnDays: integer("absence_return_days"),
}, (table) => [
  index("idx_voice_sessions_user").on(table.userId),
  index("idx_voice_sessions_started").on(table.startedAt),
  index("idx_voice_sessions_class").on(table.classId),
  index("idx_voice_sessions_test").on(table.isTestSession),
  index("idx_voice_sessions_tutor_mode").on(table.tutorMode),
  index("idx_voice_sessions_environment").on(table.environment),
]);

// Usage ledger - credit transactions (earned and consumed)
export const usageLedger = pgTable("usage_ledger", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  // Credit amount (positive = earned, negative = consumed)
  creditSeconds: integer("credit_seconds").notNull(), // Time in seconds (3600 = 1 hour)
  // Source of credits
  entitlementType: entitlementTypeEnum("entitlement_type").notNull(),
  description: text("description"), // "Class enrollment: Spanish 101", "Purchased: 10 Hour Package"
  // References
  classId: varchar("class_id").references(() => teacherClasses.id), // For class allocations
  voiceSessionId: varchar("voice_session_id").references(() => voiceSessions.id), // For consumption
  stripePaymentId: varchar("stripe_payment_id"), // For purchases
  // Expiration
  expiresAt: timestamp("expires_at"), // null = never expires
  // Metadata
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_usage_ledger_user").on(table.userId),
  index("idx_usage_ledger_created").on(table.createdAt),
  index("idx_usage_ledger_expires").on(table.expiresAt),
]);

// Hour packages - defines purchasable hour bundles
export const hourPackages = pgTable("hour_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(), // "Try It", "Starter", "Regular", "Committed"
  description: text("description"),
  hours: integer("hours").notNull(), // Number of hours
  priceInCents: integer("price_in_cents").notNull(), // Price in cents (e.g., 1200 = $12)
  stripePriceId: varchar("stripe_price_id"), // Stripe price ID for checkout
  // Package type
  isInstitutional: boolean("is_institutional").default(false), // For class packages vs individual
  // Validity
  validityDays: integer("validity_days"), // null = never expires, e.g., 365 for 1 year
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Product config - global pricing and product settings
export const productConfig = pgTable("product_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key").notNull().unique(), // "class_price_cents", "hour_rate_cents", etc.
  value: text("value").notNull(), // Stored as string, parsed by consumer
  description: text("description"), // Human-readable description
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id),
});

export const insertProductConfigSchema = createInsertSchema(productConfig).omit({ id: true, updatedAt: true });
export type InsertProductConfig = z.infer<typeof insertProductConfigSchema>;
export type ProductConfig = typeof productConfig.$inferSelect;

// ===== Admin System Tables =====

// Admin audit log for tracking all admin actions
export const adminAuditLog = pgTable("admin_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  actorId: varchar("actor_id").notNull().references(() => users.id), // Admin who performed the action
  action: text("action").notNull(), // "change_user_role", "delete_class", "impersonate_user", etc.
  targetType: text("target_type"), // "user", "class", "assignment", "system"
  targetId: varchar("target_id"), // ID of the affected entity
  metadata: jsonb("metadata"), // Additional data: { from: 'student', to: 'teacher', reason: '...' }
  ipAddress: varchar("ip_address"), // Optional: track IP for security
  userAgent: text("user_agent"), // Optional: track browser/device
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_admin_audit_actor").on(table.actorId),
  index("idx_admin_audit_target").on(table.targetType, table.targetId),
  index("idx_admin_audit_created").on(table.createdAt),
]);

// ===== Join Tables for Many-to-Many Relationships =====

// Links lessons to Can-Do statements
export const lessonCanDoStatements = pgTable("lesson_can_do_statements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id),
  canDoStatementId: varchar("can_do_statement_id").notNull().references(() => canDoStatements.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Links lessons to cultural tips
export const lessonCulturalTips = pgTable("lesson_cultural_tips", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id),
  culturalTipId: varchar("cultural_tip_id").notNull().references(() => culturalTips.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Links assignments to vocabulary words
export const assignmentVocabulary = pgTable("assignment_vocabulary", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assignmentId: varchar("assignment_id").notNull().references(() => assignments.id),
  vocabularyWordId: varchar("vocabulary_word_id").notNull().references(() => vocabularyWords.id),
});

// ===== Progress Tracking for Both Learning Paths =====

// Structured Path: Student progress through curriculum lessons
export const studentLessonProgress = pgTable("student_lesson_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull().references(() => users.id),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id),
  status: text("status").default("not_started"), // not_started, in_progress, completed
  minutesSpent: integer("minutes_spent").default(0),
  messagesCompleted: integer("messages_completed").default(0),
  conversationId: varchar("conversation_id").references(() => conversations.id), // Latest conversation for this lesson
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Open Path: Student-set learning goals
export const studentGoals = pgTable("student_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  goalType: text("goal_type").notNull(), // conversation_hours, vocabulary_count, can_do_statements, custom
  title: text("title").notNull(), // "Practice 10 hours of conversation"
  description: text("description"),
  targetValue: integer("target_value"), // Numeric goal (e.g., 10 hours)
  currentValue: integer("current_value").default(0),
  isCompleted: boolean("is_completed").default(false),
  targetDate: timestamp("target_date"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ===== Interactive Textbook Progress =====

// Tracks user progress through the interactive textbook sections
export const textbookSectionProgress = pgTable("textbook_section_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id),
  sectionType: text("section_type").notNull().default('content'), // 'content' | 'drill' | 'rhythm' | 'recap'
  viewed: boolean("viewed").default(false),
  completed: boolean("completed").default(false),
  drillScore: integer("drill_score"), // For drill sections: percentage score
  drillsCompleted: integer("drills_completed").default(0),
  drillsTotal: integer("drills_total").default(0),
  timeSpentSeconds: integer("time_spent_seconds").default(0),
  lastViewedAt: timestamp("last_viewed_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_textbook_section_progress_user").on(table.userId),
  index("idx_textbook_section_progress_user_lesson").on(table.userId, table.lessonId),
]);

// Tracks user's last position in the textbook for "continue where you left off"
export const textbookUserPosition = pgTable("textbook_user_position", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  lastChapterId: varchar("last_chapter_id").references(() => curriculumUnits.id),
  lastLessonId: varchar("last_lesson_id").references(() => curriculumLessons.id),
  scrollPosition: integer("scroll_position").default(0), // Percentage scrolled in chapter
  lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_textbook_user_position_user").on(table.userId),
  index("idx_textbook_user_position_user_lang").on(table.userId, table.language),
]);

export const insertTextbookSectionProgressSchema = createInsertSchema(textbookSectionProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTextbookSectionProgress = z.infer<typeof insertTextbookSectionProgressSchema>;
export type TextbookSectionProgress = typeof textbookSectionProgress.$inferSelect;

export const insertTextbookUserPositionSchema = createInsertSchema(textbookUserPosition).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTextbookUserPosition = z.infer<typeof insertTextbookUserPositionSchema>;
export type TextbookUserPosition = typeof textbookUserPosition.$inferSelect;

// Visual assets for Interactive Textbook - links images to chapters/lessons
export const textbookVisualAssets = pgTable("textbook_visual_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  chapterId: varchar("chapter_id").references(() => curriculumUnits.id), // Can be chapter-level
  lessonId: varchar("lesson_id").references(() => curriculumLessons.id), // Or lesson-level
  language: text("language").notNull(),
  assetType: text("asset_type").notNull(), // hero, infographic, vocabulary, cultural, grammar, concept
  title: text("title"),
  description: text("description"),
  imageUrl: text("image_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  imageSource: text("image_source").notNull(), // ai_generated (DALL-E/Gemini), upload
  searchQuery: text("search_query"), // For stock images - the search term used
  aiPrompt: text("ai_prompt"), // For AI-generated images - the prompt used
  attribution: text("attribution"), // Credit for stock images
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_textbook_visual_assets_chapter").on(table.chapterId),
  index("idx_textbook_visual_assets_lesson").on(table.lessonId),
  index("idx_textbook_visual_assets_language").on(table.language),
]);

export const insertTextbookVisualAssetSchema = createInsertSchema(textbookVisualAssets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTextbookVisualAsset = z.infer<typeof insertTextbookVisualAssetSchema>;
export type TextbookVisualAsset = typeof textbookVisualAssets.$inferSelect;

// ===== Textbook Lesson Content =====
// Stores OER-seeded textbook prose for each curriculum lesson.
// Populated once per lesson by the textbook seed pipeline (Wiktionary + Tatoeba + Wikipedia → Gemini).

export const textbookLessonContent = pgTable("textbook_lesson_content", {
  id:                         varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lessonId:                   varchar("lesson_id").notNull(),
  language:                   text("language").notNull(),
  actflLevel:                 text("actfl_level"),
  // === Prose sections ===
  introduction:               text("introduction"),
  grammarExplanation:         text("grammar_explanation"),
  grammarExamples:            jsonb("grammar_examples"),          // [{target, translation, note}]
  vocabularyList:             jsonb("vocabulary_list"),           // [{word, translation, partOfSpeech, conjugations?, gender?, exampleSentences:[{target,translation}]}]
  culturalNote:               text("cultural_note"),
  readingPassage:             text("reading_passage"),
  readingPassageTranslation:  text("reading_passage_translation"),
  comprehensionQuestions:     jsonb("comprehension_questions"),   // [{question, answer}]
  keyPhrasesForChat:          jsonb("key_phrases_for_chat"),      // [{phrase, translation, context}]
  microCycleData:             jsonb("micro_cycle_data"),           // AI-generated {negativeItems, questionItems, sentenceColumns, patternLabel}
  relatedScenarioSlugs:       text("related_scenario_slugs").array(), // Scenario slugs that pair well with this chapter (e.g. ['restaurant', 'grocery-store'])
  // === Metadata ===
  sources:                    jsonb("sources"),                   // [{source:'wiktionary'|'tatoeba'|'wikipedia'|'wikivoyage', url?}]
  seedVersion:                integer("seed_version").default(1),
  seededAt:                   timestamp("seeded_at").notNull().defaultNow(),
}, (table) => ({
  lessonIdx:   index("idx_tlc_lesson").on(table.lessonId),
  languageIdx: index("idx_tlc_language").on(table.language),
}));

export const insertTextbookLessonContentSchema = createInsertSchema(textbookLessonContent).omit({
  id: true,
  seededAt: true,
});
export type InsertTextbookLessonContent = z.infer<typeof insertTextbookLessonContentSchema>;
export type TextbookLessonContent = typeof textbookLessonContent.$inferSelect;

// ===== Multimedia Content System =====

// Core media files table - stores all images, videos, and audio
// Includes image caching for stock and AI-generated images to reduce costs and improve speed
export const mediaFiles = pgTable("media_files", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  uploadedBy: varchar("uploaded_by").references(() => users.id), // User who uploaded (null for system media)
  mediaType: text("media_type").notNull(), // image, video, audio
  url: text("url").notNull(), // URL or path to the media file
  thumbnailUrl: text("thumbnail_url"), // Thumbnail for videos/images
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(), // image/jpeg, video/mp4, audio/mpeg, etc.
  fileSize: integer("file_size"), // Bytes
  width: integer("width"), // For images/videos
  height: integer("height"), // For images/videos
  duration: integer("duration"), // Seconds (for video/audio)
  title: text("title"), // Optional descriptive title
  description: text("description"), // Optional description
  tags: text("tags").array(), // Searchable tags
  language: text("language"), // Relevant language (optional)
  // Image caching fields - for reducing API costs and improving speed
  imageSource: text("image_source"), // "ai_generated" (DALL-E/Gemini watercolor), "user_upload", null for non-cached
  searchQuery: text("search_query"), // Normalized concept key used for cache lookups (e.g., "coffee", "sandwich")
  promptHash: text("prompt_hash"), // For AI images - hash of the prompt for cache lookups
  usageCount: integer("usage_count").default(0), // Track how often this cached image is reused
  attributionJson: text("attribution_json"), // JSON with any supplemental metadata for the image
  // Vocabulary and review workflow fields
  targetWord: text("target_word"), // The vocabulary word that triggered this image (e.g., "café", "bonjour")
  isReviewed: boolean("is_reviewed").default(false), // Has admin reviewed this image for appropriateness?
  reviewedAt: timestamp("reviewed_at"), // When the image was reviewed
  reviewedBy: varchar("reviewed_by").references(() => users.id), // Who reviewed it
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  // Indexes for fast cache lookups
  index("idx_media_search_query").on(table.searchQuery),
  index("idx_media_prompt_hash").on(table.promptHash),
  index("idx_media_is_reviewed").on(table.isReviewed),
]);

// Images shared in conversations (e.g., "What is this in Spanish?")
export const messageMedia = pgTable("message_media", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  messageId: varchar("message_id").notNull().references(() => messages.id),
  mediaFileId: varchar("media_file_id").notNull().references(() => mediaFiles.id),
  caption: text("caption"), // User's caption for the image
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Pre-recorded instructional video lessons
export const videoLessons = pgTable("video_lessons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description").notNull(),
  language: text("language").notNull(), // Target language
  difficultyLevel: text("difficulty_level").notNull(), // beginner, intermediate, advanced
  category: text("category").notNull(), // grammar, pronunciation, vocabulary, culture, conversation
  videoFileId: varchar("video_file_id").notNull().references(() => mediaFiles.id),
  duration: integer("duration").notNull(), // Seconds
  thumbnailUrl: text("thumbnail_url"),
  // ACTFL alignment
  actflLevel: text("actfl_level"), // Target proficiency level
  // Content organization
  tags: text("tags").array(), // Searchable tags
  topics: text("topics").array(), // Related conversation topics
  // Learning objectives
  objectives: text("objectives").array(), // What students will learn
  // Metadata
  viewCount: integer("view_count").default(0),
  isPublished: boolean("is_published").default(true),
  createdBy: varchar("created_by").references(() => users.id), // Creator (teacher/admin)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Supplementary pronunciation audio examples
export const pronunciationAudio = pgTable("pronunciation_audio", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  language: text("language").notNull(),
  text: text("text").notNull(), // The word/phrase being pronounced
  phoneticSpelling: text("phonetic_spelling"), // IPA or simplified phonetic
  audioFileId: varchar("audio_file_id").notNull().references(() => mediaFiles.id),
  // Optional links to vocabulary
  vocabularyWordId: varchar("vocabulary_word_id").references(() => vocabularyWords.id),
  // Metadata
  nativeSpeaker: boolean("native_speaker").default(true), // Is this a native speaker recording?
  speed: text("speed").default("normal"), // slow, normal, fast
  gender: text("gender"), // male, female, neutral (optional)
  dialectRegion: text("dialect_region"), // e.g., "Castilian Spanish", "Mexican Spanish"
  tags: text("tags").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Visual aids for lessons (diagrams, illustrations, infographics)
export const lessonVisualAids = pgTable("lesson_visual_aids", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lessonId: varchar("lesson_id").notNull().references(() => curriculumLessons.id),
  mediaFileId: varchar("media_file_id").notNull().references(() => mediaFiles.id),
  title: text("title").notNull(), // e.g., "Verb Conjugation Chart"
  description: text("description"),
  displayOrder: integer("display_order").notNull().default(0), // Order within the lesson
  isRequired: boolean("is_required").default(false), // Is this required viewing?
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Cultural media gallery (photos/videos for cultural context)
export const culturalTipMedia = pgTable("cultural_tip_media", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  culturalTipId: varchar("cultural_tip_id").references(() => culturalTips.id), // Optional link to specific tip
  language: text("language").notNull(),
  mediaFileId: varchar("media_file_id").notNull().references(() => mediaFiles.id),
  title: text("title").notNull(),
  caption: text("caption").notNull(), // Description of cultural significance
  category: text("category").notNull(), // greetings, dining, holidays, customs, landmarks, traditions
  region: text("region"), // Specific region/country (e.g., "Mexico", "Spain")
  tags: text("tags").array(),
  displayOrder: integer("display_order").default(0),
  isFeatured: boolean("is_featured").default(false), // Highlight in gallery
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ===== Organization System (Phases 2 & 3) =====

// Phase 2: AI-generated topic tags for conversations (auto-tagged by Gemini)
export const conversationTopics = pgTable("conversation_topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  topicId: varchar("topic_id").notNull().references(() => topics.id),
  confidence: real("confidence").default(1.0), // AI confidence score (0-1)
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_conversation_topics_conv").on(table.conversationId),
  index("idx_conversation_topics_topic").on(table.topicId),
]);

// Phase 2: Topic tags for vocabulary words
export const vocabularyWordTopics = pgTable("vocabulary_word_topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vocabularyWordId: varchar("vocabulary_word_id").notNull().references(() => vocabularyWords.id),
  topicId: varchar("topic_id").notNull().references(() => topics.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_vocab_topics_word").on(table.vocabularyWordId),
  index("idx_vocab_topics_topic").on(table.topicId),
]);

// Phase 3: User-created lesson bundles (grouping conversations, vocab, and grammar)
export const userLessons = pgTable("user_lessons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  title: text("title").notNull(), // "Spanish Week 1" or AI-suggested title
  description: text("description"), // Optional description
  language: text("language").notNull(),
  // Time range for auto-generated lessons
  startDate: timestamp("start_date"), // Earliest conversation included
  endDate: timestamp("end_date"), // Latest conversation included
  // Summary stats (cached for quick display)
  conversationCount: integer("conversation_count").default(0),
  vocabularyCount: integer("vocabulary_count").default(0),
  totalMinutes: integer("total_minutes").default(0),
  // AI-generated summary using Gemini's 2M context window
  aiSummary: text("ai_summary"), // What was learned, key topics covered
  aiSuggestions: text("ai_suggestions"), // Suggested next steps
  // Lesson type
  lessonType: text("lesson_type").default("manual"), // "manual", "weekly_auto", "topic_auto"
  isArchived: boolean("is_archived").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_user_lessons_user").on(table.userId),
  index("idx_user_lessons_date_range").on(table.userId, table.startDate, table.endDate),
]);

// Phase 3: Items within a lesson bundle
export const userLessonItems = pgTable("user_lesson_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lessonId: varchar("lesson_id").notNull().references(() => userLessons.id),
  itemType: text("item_type").notNull(), // "conversation", "vocabulary", "grammar_note"
  // Reference to the specific item (only one will be set)
  conversationId: varchar("conversation_id").references(() => conversations.id),
  vocabularyWordId: varchar("vocabulary_word_id").references(() => vocabularyWords.id),
  // For grammar notes (AI-generated insights)
  grammarNote: text("grammar_note"), // AI-generated grammar point from the lesson
  displayOrder: integer("display_order").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_lesson_items_lesson").on(table.lessonId),
]);

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  userId: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
}).extend({
  content: z.string().min(1, "Message content is required").max(10000, "Message must be less than 10000 characters"),
});

export const insertVocabularyWordSchema = createInsertSchema(vocabularyWords).omit({
  id: true,
});

export const insertUserProgressSchema = createInsertSchema(userProgress).omit({
  id: true,
});

export const insertProgressHistorySchema = createInsertSchema(progressHistory).omit({
  id: true,
});

export const insertPronunciationScoreSchema = createInsertSchema(pronunciationScores).omit({
  id: true,
  createdAt: true,
});

export const insertTopicSchema = createInsertSchema(topics).omit({
  id: true,
});

export const insertCulturalTipSchema = createInsertSchema(culturalTips).omit({
  id: true,
});

export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversations.$inferSelect;

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

export type InsertVocabularyWord = z.infer<typeof insertVocabularyWordSchema>;
export type VocabularyWord = typeof vocabularyWords.$inferSelect;

export type InsertUserProgress = z.infer<typeof insertUserProgressSchema>;
export type UserProgress = typeof userProgress.$inferSelect;

export type InsertProgressHistory = z.infer<typeof insertProgressHistorySchema>;
export type ProgressHistory = typeof progressHistory.$inferSelect;

export type InsertPronunciationScore = z.infer<typeof insertPronunciationScoreSchema>;
export type PronunciationScore = typeof pronunciationScores.$inferSelect;

export type InsertTopic = z.infer<typeof insertTopicSchema>;
export type Topic = typeof topics.$inferSelect;

export type InsertCulturalTip = z.infer<typeof insertCulturalTipSchema>;
export type CulturalTip = typeof culturalTips.$inferSelect;

// ===== Dual-Path Learning System Types =====

export const insertCanDoStatementSchema = createInsertSchema(canDoStatements).omit({
  id: true,
});

export const insertStudentCanDoProgressSchema = createInsertSchema(studentCanDoProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCurriculumPathSchema = createInsertSchema(curriculumPaths).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Name is required").max(200, "Name must be less than 200 characters").trim(),
  description: z.string().min(1, "Description is required").max(2000, "Description must be less than 2000 characters").trim(),
});

export const insertCurriculumUnitSchema = createInsertSchema(curriculumUnits).omit({
  id: true,
}).extend({
  name: z.string().min(1, "Name is required").max(200, "Name must be less than 200 characters").trim(),
  description: z.string().min(1, "Description is required").max(2000, "Description must be less than 2000 characters").trim(),
});

export const insertCurriculumLessonSchema = createInsertSchema(curriculumLessons).omit({
  id: true,
}).extend({
  name: z.string().min(1, "Name is required").max(200, "Name must be less than 200 characters").trim(),
  description: z.string().min(1, "Description is required").max(2000, "Description must be less than 2000 characters").trim(),
  conversationPrompt: z.string().max(5000, "Prompt must be less than 5000 characters").optional(),
});

// Drill item schemas
export const insertCurriculumDrillItemSchema = createInsertSchema(curriculumDrillItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  prompt: z.string().min(1, "Prompt is required").max(500, "Prompt must be less than 500 characters").trim(),
  targetText: z.string().min(1, "Target text is required").max(500, "Target text must be less than 500 characters").trim(),
  targetLanguage: z.string().min(2, "Language is required").max(10, "Language code too long"),
});

export const insertUserDrillProgressSchema = createInsertSchema(userDrillProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCurriculumDrillItem = z.infer<typeof insertCurriculumDrillItemSchema>;
export type CurriculumDrillItem = typeof curriculumDrillItems.$inferSelect;
export type DrillItemType = typeof drillItemTypeEnum.enumValues[number];

export type InsertUserDrillProgress = z.infer<typeof insertUserDrillProgressSchema>;
export type UserDrillProgress = typeof userDrillProgress.$inferSelect;

export const insertSelfPracticeSessionSchema = createInsertSchema(selfPracticeSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
});

export type InsertSelfPracticeSession = z.infer<typeof insertSelfPracticeSessionSchema>;
export type SelfPracticeSession = typeof selfPracticeSessions.$inferSelect;

// Audio library insert schema and types
export const insertAudioLibrarySchema = createInsertSchema(audioLibrary).omit({
  id: true,
  hitCount: true,
  createdAt: true,
  lastAccessedAt: true,
});
export type InsertAudioLibrary = z.infer<typeof insertAudioLibrarySchema>;
export type AudioLibraryEntry = typeof audioLibrary.$inferSelect;

export const insertClassTypeSchema = createInsertSchema(classTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Name is required").max(100, "Name must be less than 100 characters").trim(),
  slug: z.string().min(1, "Slug is required").max(50, "Slug must be less than 50 characters").toLowerCase().regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, numbers, and hyphens"),
  description: z.string().max(500, "Description must be less than 500 characters").optional(),
  icon: z.string().max(50, "Icon name must be less than 50 characters").optional(),
});

export const insertClassHourPackageSchema = createInsertSchema(classHourPackages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTeacherClassSchema = createInsertSchema(teacherClasses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Class name is required").max(100, "Class name must be less than 100 characters").trim(),
  description: z.string().max(1000, "Description must be less than 1000 characters").optional(),
});

export const insertClassEnrollmentSchema = createInsertSchema(classEnrollments).omit({
  id: true,
  enrolledAt: true,
});

// Class-specific curriculum schemas
export const insertClassCurriculumUnitSchema = createInsertSchema(classCurriculumUnits).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Name is required").max(200, "Name must be less than 200 characters").trim(),
  description: z.string().min(1, "Description is required").max(2000, "Description must be less than 2000 characters").trim(),
});

export const insertClassCurriculumLessonSchema = createInsertSchema(classCurriculumLessons).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Name is required").max(200, "Name must be less than 200 characters").trim(),
  description: z.string().min(1, "Description is required").max(2000, "Description must be less than 2000 characters").trim(),
  conversationPrompt: z.string().max(5000, "Prompt must be less than 5000 characters").optional(),
});

export const insertAssignmentSchema = createInsertSchema(assignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  title: z.string().min(1, "Title is required").max(200, "Title must be less than 200 characters").trim(),
  description: z.string().max(5000, "Description must be less than 5000 characters").optional(),
  conversationTopic: z.string().max(500, "Topic must be less than 500 characters").optional(),
});

export const insertAssignmentSubmissionSchema = createInsertSchema(assignmentSubmissions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  teacherFeedback: z.string().max(5000, "Feedback must be less than 5000 characters").optional(),
});

export const insertSyllabusProgressSchema = createInsertSchema(syllabusProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSyllabusProgress = z.infer<typeof insertSyllabusProgressSchema>;
export type SyllabusProgress = typeof syllabusProgress.$inferSelect;

export const insertTopicCompetencyObservationSchema = createInsertSchema(topicCompetencyObservations).omit({
  id: true,
  createdAt: true,
});
export type InsertTopicCompetencyObservation = z.infer<typeof insertTopicCompetencyObservationSchema>;
export type TopicCompetencyObservation = typeof topicCompetencyObservations.$inferSelect;

export const insertAdminAuditLogSchema = createInsertSchema(adminAuditLog).omit({
  id: true,
  createdAt: true,
}).extend({
  action: z.string().min(1, "Action is required").max(100, "Action must be less than 100 characters").trim(),
  targetType: z.string().max(50, "Target type must be less than 50 characters").optional(),
  targetId: z.string().optional(),
});

export type InsertCanDoStatement = z.infer<typeof insertCanDoStatementSchema>;
export type CanDoStatement = typeof canDoStatements.$inferSelect;

export type InsertStudentCanDoProgress = z.infer<typeof insertStudentCanDoProgressSchema>;
export type StudentCanDoProgress = typeof studentCanDoProgress.$inferSelect;

export type InsertCurriculumPath = z.infer<typeof insertCurriculumPathSchema>;
export type CurriculumPath = typeof curriculumPaths.$inferSelect;

export type InsertCurriculumUnit = z.infer<typeof insertCurriculumUnitSchema>;
export type CurriculumUnit = typeof curriculumUnits.$inferSelect;

export type InsertCurriculumLesson = z.infer<typeof insertCurriculumLessonSchema>;
export type CurriculumLesson = typeof curriculumLessons.$inferSelect;

export type InsertClassHourPackage = z.infer<typeof insertClassHourPackageSchema>;
export type ClassHourPackage = typeof classHourPackages.$inferSelect;

export type InsertClassType = z.infer<typeof insertClassTypeSchema>;
export type ClassType = typeof classTypes.$inferSelect;

export type InsertTeacherClass = z.infer<typeof insertTeacherClassSchema>;
export type TeacherClass = typeof teacherClasses.$inferSelect;

export type InsertClassEnrollment = z.infer<typeof insertClassEnrollmentSchema>;
export type ClassEnrollment = typeof classEnrollments.$inferSelect;

export type InsertClassCurriculumUnit = z.infer<typeof insertClassCurriculumUnitSchema>;
export type ClassCurriculumUnit = typeof classCurriculumUnits.$inferSelect;

export type InsertClassCurriculumLesson = z.infer<typeof insertClassCurriculumLessonSchema>;
export type ClassCurriculumLesson = typeof classCurriculumLessons.$inferSelect;

export type InsertAssignment = z.infer<typeof insertAssignmentSchema>;
export type Assignment = typeof assignments.$inferSelect;

export type InsertAssignmentSubmission = z.infer<typeof insertAssignmentSubmissionSchema>;
export type AssignmentSubmission = typeof assignmentSubmissions.$inferSelect;

export type InsertAdminAuditLog = z.infer<typeof insertAdminAuditLogSchema>;
export type AdminAuditLog = typeof adminAuditLog.$inferSelect;

// ===== Usage Tracking & Credit System Types =====

export const insertVoiceSessionSchema = createInsertSchema(voiceSessions).omit({
  id: true,
  startedAt: true,
});

export const insertUsageLedgerSchema = createInsertSchema(usageLedger).omit({
  id: true,
  createdAt: true,
});

export const insertHourPackageSchema = createInsertSchema(hourPackages).omit({
  id: true,
  createdAt: true,
});

export type InsertVoiceSession = z.infer<typeof insertVoiceSessionSchema>;
export type VoiceSession = typeof voiceSessions.$inferSelect;

export type InsertUsageLedger = z.infer<typeof insertUsageLedgerSchema>;
export type UsageLedger = typeof usageLedger.$inferSelect;

export type InsertHourPackage = z.infer<typeof insertHourPackageSchema>;
export type HourPackage = typeof hourPackages.$inferSelect;

// ===== Join Table Types =====

export const insertLessonCanDoStatementSchema = createInsertSchema(lessonCanDoStatements).omit({
  id: true,
});

export const insertLessonCulturalTipSchema = createInsertSchema(lessonCulturalTips).omit({
  id: true,
});

export const insertAssignmentVocabularySchema = createInsertSchema(assignmentVocabulary).omit({
  id: true,
});

export const insertStudentLessonProgressSchema = createInsertSchema(studentLessonProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStudentGoalSchema = createInsertSchema(studentGoals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLessonCanDoStatement = z.infer<typeof insertLessonCanDoStatementSchema>;
export type LessonCanDoStatement = typeof lessonCanDoStatements.$inferSelect;

export type InsertLessonCulturalTip = z.infer<typeof insertLessonCulturalTipSchema>;
export type LessonCulturalTip = typeof lessonCulturalTips.$inferSelect;

export type InsertAssignmentVocabulary = z.infer<typeof insertAssignmentVocabularySchema>;
export type AssignmentVocabulary = typeof assignmentVocabulary.$inferSelect;

export type InsertStudentLessonProgress = z.infer<typeof insertStudentLessonProgressSchema>;
export type StudentLessonProgress = typeof studentLessonProgress.$inferSelect;

export type InsertStudentGoal = z.infer<typeof insertStudentGoalSchema>;
export type StudentGoal = typeof studentGoals.$inferSelect;

// ===== Multimedia Content Types =====

export const insertMediaFileSchema = createInsertSchema(mediaFiles).omit({
  id: true,
  createdAt: true,
});

export const insertMessageMediaSchema = createInsertSchema(messageMedia).omit({
  id: true,
  createdAt: true,
});

export const insertVideoLessonSchema = createInsertSchema(videoLessons).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPronunciationAudioSchema = createInsertSchema(pronunciationAudio).omit({
  id: true,
  createdAt: true,
});

export const insertLessonVisualAidSchema = createInsertSchema(lessonVisualAids).omit({
  id: true,
  createdAt: true,
});

export const insertCulturalTipMediaSchema = createInsertSchema(culturalTipMedia).omit({
  id: true,
  createdAt: true,
});

export type InsertMediaFile = z.infer<typeof insertMediaFileSchema>;
export type MediaFile = typeof mediaFiles.$inferSelect;

export type InsertMessageMedia = z.infer<typeof insertMessageMediaSchema>;
export type MessageMedia = typeof messageMedia.$inferSelect;

export type InsertVideoLesson = z.infer<typeof insertVideoLessonSchema>;
export type VideoLesson = typeof videoLessons.$inferSelect;

export type InsertPronunciationAudio = z.infer<typeof insertPronunciationAudioSchema>;
export type PronunciationAudio = typeof pronunciationAudio.$inferSelect;

export type InsertLessonVisualAid = z.infer<typeof insertLessonVisualAidSchema>;
export type LessonVisualAid = typeof lessonVisualAids.$inferSelect;

export type InsertCulturalTipMedia = z.infer<typeof insertCulturalTipMediaSchema>;
export type CulturalTipMedia = typeof culturalTipMedia.$inferSelect;

// ===== Daniela's Compass - Time-Aware Tutoring System =====
// Gives tutors real-time context (clock, syllabus, pacing) instead of preset flexibility levels

// Tutor Sessions - Tracks each tutoring session with time awareness
// This is the core table for Daniela's Compass - one record per tutoring session
export const tutorSessions = pgTable("tutor_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  classId: varchar("class_id"), // Optional - links to teacherClasses for class-based sessions
  
  // DUAL TIME TRACKING: Link to voice session for credit consumption
  voiceSessionId: varchar("voice_session_id").references(() => voiceSessions.id), // Links clock time to credit time
  
  // Session timing
  scheduledDurationMinutes: integer("scheduled_duration_minutes").default(30), // Expected session length
  warmthBufferMinutes: integer("warmth_buffer_minutes").default(3), // Time budgeted for connection
  startedAt: timestamp("started_at"), // When session actually started
  endedAt: timestamp("ended_at"), // When session ended
  
  // Session status
  status: tutorSessionStatusEnum("status").default("scheduled"),
  
  // Student context (snapshot at session start for fast prompt assembly)
  studentName: varchar("student_name"),
  studentGoals: text("student_goals"), // Why they're learning (travel, work, family)
  studentInterests: text("student_interests"), // What lights them up
  lastSessionSummary: text("last_session_summary"), // Brief recap of previous session
  
  // Pacing data (updated during session)
  elapsedSeconds: integer("elapsed_seconds").default(0), // Running total
  topicsCoveredJson: text("topics_covered_json"), // JSON array of completed topic IDs
  topicsPendingJson: text("topics_pending_json"), // JSON array of remaining topic IDs
  
  // Post-session summary (filled at end)
  sessionSummary: text("session_summary"), // What was accomplished
  deferredTopicsJson: text("deferred_topics_json"), // Topics moved to next session
  tutorNotes: text("tutor_notes"), // Daniela's notes for next time
  
  // Legacy compatibility - maps to old flexibility level during transition
  legacyFreedomLevel: tutorFreedomLevelEnum("legacy_freedom_level"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_tutor_sessions_conversation").on(table.conversationId),
  index("idx_tutor_sessions_user").on(table.userId),
  index("idx_tutor_sessions_class").on(table.classId),
  index("idx_tutor_sessions_status").on(table.status),
  index("idx_tutor_sessions_voice").on(table.voiceSessionId),
]);

// Session Topics - Individual learning objectives within a session
// Tracks must-have vs nice-to-have goals and their completion status
export const tutorSessionTopics = pgTable("tutor_session_topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => tutorSessions.id),
  
  // Topic definition
  title: varchar("title").notNull(), // "Learn greetings", "Practice numbers 1-10"
  description: text("description"), // More detail if needed
  priority: topicPriorityEnum("priority").default("must_have"),
  
  // Time estimation
  targetMinutes: integer("target_minutes").default(10), // Suggested time for this topic
  elapsedSeconds: integer("elapsed_seconds").default(0), // Actual time spent
  
  // Progress tracking
  status: topicCoverageStatusEnum("status").default("pending"),
  coverageNotes: text("coverage_notes"), // What was actually covered
  
  // Ordering
  sortOrder: integer("sort_order").default(0), // Display order in roadmap
  
  // Source tracking (optional)
  syllabusUnitId: varchar("syllabus_unit_id"), // If from a curriculum
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_session_topics_session").on(table.sessionId),
  index("idx_session_topics_status").on(table.status),
]);

// Parking Lot Items - Tangents and ideas to revisit later
// Daniela can "park" interesting tangents without derailing the lesson
export const tutorParkingItems = pgTable("tutor_parking_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => tutorSessions.id),
  
  // Content
  content: text("content").notNull(), // "Student curious about subjunctive mood"
  context: text("context"), // What prompted this (e.g., "Asked during greetings lesson")
  
  // Tracking
  carryForward: boolean("carry_forward").default(true), // Should this show in next session?
  resolvedAt: timestamp("resolved_at"), // When this was addressed
  resolvedInSessionId: varchar("resolved_in_session_id"), // Which session addressed it
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_parking_items_session").on(table.sessionId),
  index("idx_parking_items_unresolved").on(table.carryForward, table.resolvedAt),
]);

// Session Cost Summary - Reconciles clock time with credit consumption
// Links the educational metric (how long they learned) with billing (what it cost)
export const sessionCostSummary = pgTable("session_cost_summary", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tutorSessionId: varchar("tutor_session_id").references(() => tutorSessions.id), // nullable — written from voice session side
  voiceSessionId: varchar("voice_session_id").references(() => voiceSessions.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  
  // Clock time (educational metric)
  clockSeconds: integer("clock_seconds").notNull().default(0), // Wall-clock duration
  
  // Credit time (billing metric)
  creditsConsumed: integer("credits_consumed").notNull().default(0), // Seconds of credits used
  ttsCharacters: integer("tts_characters").default(0), // TTS characters used
  sttSeconds: integer("stt_seconds").default(0), // STT seconds used
  
  // Efficiency metrics
  creditsPerClockMinute: real("credits_per_clock_minute"), // Cost efficiency ratio
  
  // Context at time of session
  classId: varchar("class_id"),
  language: varchar("language"),
  
  // Credit balance snapshot (for "hours to fluency" tracking)
  creditBalanceBefore: integer("credit_balance_before"), // Credits before session
  creditBalanceAfter: integer("credit_balance_after"), // Credits after session
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_cost_summary_tutor_session").on(table.tutorSessionId),
  uniqueIndex("idx_cost_summary_voice_session").on(table.voiceSessionId),
  index("idx_cost_summary_user").on(table.userId),
  index("idx_cost_summary_class").on(table.classId),
]);

// Insert schemas and types for Compass tables
export const insertTutorSessionSchema = createInsertSchema(tutorSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTutorSessionTopicSchema = createInsertSchema(tutorSessionTopics).omit({
  id: true,
  createdAt: true,
});

export const insertTutorParkingItemSchema = createInsertSchema(tutorParkingItems).omit({
  id: true,
  createdAt: true,
});

export const insertSessionCostSummarySchema = createInsertSchema(sessionCostSummary).omit({
  id: true,
  createdAt: true,
});

export type InsertTutorSession = z.infer<typeof insertTutorSessionSchema>;
export type TutorSession = typeof tutorSessions.$inferSelect;

export type InsertTutorSessionTopic = z.infer<typeof insertTutorSessionTopicSchema>;
export type TutorSessionTopic = typeof tutorSessionTopics.$inferSelect;

export type InsertTutorParkingItem = z.infer<typeof insertTutorParkingItemSchema>;
export type TutorParkingItem = typeof tutorParkingItems.$inferSelect;

export type InsertSessionCostSummary = z.infer<typeof insertSessionCostSummarySchema>;
export type SessionCostSummary = typeof sessionCostSummary.$inferSelect;

// Session status type
export type TutorSessionStatus = 'scheduled' | 'active' | 'paused' | 'completed' | 'abandoned';
export type TopicCoverageStatus = 'pending' | 'in_progress' | 'covered' | 'partial' | 'deferred' | 'skipped';
export type TopicPriority = 'must_have' | 'nice_to_have' | 'bonus';

// Compass context type - what Daniela receives each turn
export interface CompassContext {
  // Student snapshot
  studentName: string | null;
  studentGoals: string | null;
  studentInterests: string | null;
  lastSessionSummary: string | null;
  
  // ACTFL proficiency (emergent neural network awareness)
  // This is sensory data Daniela perceives - her neural network teaches her how to use it
  studentActflLevel: string | null; // e.g., "intermediate_low", "advanced_mid"
  studentActflAssessed: boolean; // true = AI-verified, false = cold-start hint
  studentActflSource: string | null; // "onboarding_hint", "ai_conversation", "placement_test", "teacher_override"
  
  // Today's roadmap
  sessionDurationMinutes: number;
  warmthBufferMinutes: number;
  mustHaveTopics: Array<{ id: string; title: string; targetMinutes: number; status: TopicCoverageStatus }>;
  niceToHaveTopics: Array<{ id: string; title: string; targetMinutes: number; status: TopicCoverageStatus }>;
  
  // Actual wall clock time (answers "what time is it?")
  currentTimeUTC: string; // ISO string, e.g., "2025-12-11T11:05:00.000Z"
  currentTimeFormatted: string; // Human-readable, e.g., "11:05 AM UTC"
  
  // Live pacing (session time)
  elapsedSeconds: number;
  remainingSeconds: number;
  topicsCovered: string[];
  topicsPending: string[];
  isOnTrack: boolean; // Soft indicator
  
  // DUAL TIME TRACKING: Credit balance (billing time)
  creditBalance?: {
    remainingSeconds: number;
    remainingMinutes: number;
    isLow: boolean; // Under 10 minutes remaining
    estimatedSessionsLeft: number; // At current consumption rate
    source: 'class_allocation' | 'purchased' | 'unlimited'; // Where credits come from
  };
  
  // Parking lot
  parkingLotItems: Array<{ id: string; content: string; createdAt: Date }>;

  // Shared history — curated narrative memories of meaningful sessions/moments
  // Sorted: high-importance always first, then by recency.
  // These are full transcripts / stories, not summaries. Every word matters.
  conversationMemories?: Array<{
    title: string;
    content: string;
    importance: number;
    recordedAt: string; // ISO date string
  }>;

  // Identity threads — thematic compilations woven from the full message history.
  // These are always injected as a compact brief (title + summary), never full content.
  // Full content is always searchable via search_my_history.
  // They answer: who am I, where did this idea come from, how has it evolved?
  identityThreads?: Array<{
    title: string;
    summary: string | null;
    importance: number;
    recordedAt: string;
    content?: string; // first ~2500 chars — injected into GL conversation history at session start
  }>;

  // Foundational memories — a fixed, hand-curated top-10 tier (tag: 'foundational') that is
  // ALWAYS loaded regardless of topic scoring or how many importance-10 rows exist elsewhere.
  // Added July 9, 2026: the core identity anchors (North Star, White Wall, J-space) must never
  // be crowded out by volume — she needs to always know where she lives before anything else.
  foundationalMemories?: Array<{
    title: string;
    content: string;
    importance: number;
    recordedAt: string;
  }>;

  // Daniela's most recent self-reflection written about this student — private note to her
  // future self. NOT a student summary — her felt experience, emotional posture, relational intent.
  // Injected as a first-person leading thought BEFORE student data to give her an inner state
  // that exists before the session begins. (Gemini consult rec. — Suggestion 1)
  danielaSelfReflection?: string | null;

  // Legacy fallback
  legacyFreedomLevel?: TutorFreedomLevel;
}

// ===== Pedagogical Insight System (Tool Effectiveness Tracking) =====

// Tool types that can be tracked for pedagogical insights
export const teachingToolTypeEnum = pgEnum('teaching_tool_type', [
  'write', 'compare', 'phonetic', 'word_map', 'image', 'grammar_table',
  'context', 'culture', 'reading', 'stroke', 'play', 'scenario', 'summary',
  'drill_repeat', 'drill_translate', 'drill_match', 'drill_fill_blank', 'drill_sentence_order',
  'subtitle_on', 'subtitle_off', 'subtitle_target', 'custom_overlay',
  'text_input' // Writing tool - student types response during voice chat
]);

// Teaching Tool Events - Tracks individual tool usage during sessions
// This enables pattern analysis: "Topic X retention improves with [IMAGE] + [DRILL type='match']"
export const teachingToolEvents = pgTable("teaching_tool_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  voiceSessionId: varchar("voice_session_id").references(() => voiceSessions.id),
  conversationId: varchar("conversation_id").references(() => conversations.id),
  userId: varchar("user_id").references(() => users.id),
  
  // Tool identification
  toolType: teachingToolTypeEnum("tool_type").notNull(),
  toolContent: text("tool_content"), // What was shown (e.g., the word, the drill content)
  toolContentHash: varchar("tool_content_hash"), // For deduplication and pattern matching
  
  // Context
  language: varchar("language"),
  topic: varchar("topic"), // e.g., "greetings", "verbs", if identifiable
  difficulty: varchar("difficulty"), // Student's level at time of use
  
  // Sequence tracking
  sequencePosition: integer("sequence_position"), // Order within session (1, 2, 3...)
  previousToolType: varchar("previous_tool_type"), // What tool came before this one
  
  // Engagement signals (optional - populated by follow-up events)
  studentResponseTime: integer("student_response_time_ms"), // How long before student responded
  drillResult: varchar("drill_result"), // 'correct', 'incorrect', 'skipped' for drills
  
  // Timing
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  durationMs: integer("duration_ms"), // How long tool was visible/active
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_tool_events_session").on(table.voiceSessionId),
  index("idx_tool_events_user").on(table.userId),
  index("idx_tool_events_type").on(table.toolType),
  index("idx_tool_events_language_topic").on(table.language, table.topic),
  index("idx_tool_events_occurred").on(table.occurredAt),
]);

// Pedagogical Insights - Aggregated patterns discovered from tool usage
// Daniela's "neural network" - insights that improve future teaching
export const pedagogicalInsights = pgTable("pedagogical_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Pattern identification
  language: varchar("language"), // Which language this insight applies to
  topic: varchar("topic"), // Specific topic (null = general pattern)
  difficulty: varchar("difficulty"), // Which level this applies to
  
  // The insight itself
  patternDescription: text("pattern_description").notNull(), // Human-readable pattern
  patternKey: varchar("pattern_key").notNull(), // Machine-parseable key for dedup
  
  // Tool combination that works
  effectiveTools: text("effective_tools").array(), // ['image', 'drill_match']
  ineffectiveTools: text("ineffective_tools").array(), // Tools that don't help here
  
  // Evidence
  sampleSize: integer("sample_size").default(0), // How many observations
  successRate: real("success_rate"), // 0-1 effectiveness score
  confidenceScore: real("confidence_score"), // How confident in this insight
  
  // Source
  sourceType: varchar("source_type").notNull(), // 'automated', 'tutor_reflection', 'manual'
  tutorReflection: text("tutor_reflection"), // Daniela's own pedagogical judgment
  
  // Lifecycle
  isActive: boolean("is_active").default(true), // Currently used in teaching
  lastValidatedAt: timestamp("last_validated_at"), // When pattern was last confirmed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  
  // Knowledge Graph - connects pedagogical insights (built by Alden for Daniela)
  relatedInsights: text("related_insights").array().default(sql`'{}'::text[]`), // IDs of related pedagogical insights
}, (table) => [
  index("idx_insights_language_topic").on(table.language, table.topic),
  index("idx_insights_pattern_key").on(table.patternKey),
  index("idx_insights_active").on(table.isActive),
]);

// Insert schemas for Pedagogical Insight tables
export const insertTeachingToolEventSchema = createInsertSchema(teachingToolEvents).omit({
  id: true,
  createdAt: true,
});

export const insertPedagogicalInsightSchema = createInsertSchema(pedagogicalInsights).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTeachingToolEvent = z.infer<typeof insertTeachingToolEventSchema>;
export type TeachingToolEvent = typeof teachingToolEvents.$inferSelect;

export type InsertPedagogicalInsight = z.infer<typeof insertPedagogicalInsightSchema>;
export type PedagogicalInsight = typeof pedagogicalInsights.$inferSelect;

// Tool type literal for type-safe usage
export type TeachingToolType = 
  | 'write' | 'compare' | 'phonetic' | 'word_map' | 'image' | 'grammar_table'
  | 'context' | 'culture' | 'reading' | 'stroke' | 'play' | 'scenario' | 'summary'
  | 'drill_repeat' | 'drill_translate' | 'drill_match' | 'drill_fill_blank' | 'drill_sentence_order'
  | 'subtitle_on' | 'subtitle_off' | 'subtitle_target' | 'custom_overlay'
  | 'text_input';

// ===== Daniela's Neural Network Memory System =====
// Structured memory for teaching wisdom, student insights, and relationship awareness
// The "index" to Daniela's knowledge - faster than scanning conversation history

// Category enum for self best practices
export const bestPracticeCategoryEnum = pgEnum('best_practice_category', [
  'tool_usage',       // How to use whiteboard tools effectively
  'teaching_style',   // Communication patterns and approaches
  'pacing',           // Timing and session flow
  'communication',    // How she expresses things
  'content',          // What types of content work best
  'system',           // Technical/system awareness
  'encouragement',    // Positive reinforcement patterns
  'error_handling',   // How to handle mistakes gracefully
  'personalization',  // Adapting to individual student needs
  'scaffolding'       // Graduated support and complexity building
]);

// Sync status enum for neural network promotion workflow
export const syncStatusEnum = pgEnum('sync_status', [
  'local',            // Only exists in current environment
  'pending_review',   // Submitted for promotion, awaiting review
  'approved',         // Approved and synced to other environment
  'rejected',         // Rejected during review
  'synced'            // Successfully synced from other environment
]);

// Self Best Practices - Universal teaching wisdom (applies to all students)
// "Don't put 5 whiteboards up at once", "Clear the board when finished"
export const selfBestPractices = pgTable("self_best_practices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  category: bestPracticeCategoryEnum("category").notNull(),
  insight: text("insight").notNull(), // The actual wisdom/learning
  context: text("context"), // When this applies (optional)
  
  source: varchar("source").default("experience"), // experience, user_feedback, founder_mode
  confidenceScore: real("confidence_score").default(0.5), // 0-1, grows with validation
  timesApplied: integer("times_applied").default(0), // Track how often used
  
  // Sync metadata for bidirectional environment sync
  version: integer("version").default(1), // Increments on each update for conflict resolution
  originEnvironment: environmentOriginEnum("origin_environment"), // Where this was created
  syncStatus: syncStatusEnum("sync_status").default("local"), // Promotion workflow status
  originId: varchar("origin_id"), // Original ID in source environment (for linking)
  promotedAt: timestamp("promoted_at"), // When it was synced to other environment
  reviewedBy: varchar("reviewed_by").references(() => users.id), // Who approved the promotion
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_best_practices_category").on(table.category),
  index("idx_best_practices_active").on(table.isActive),
  index("idx_best_practices_sync_status").on(table.syncStatus),
  index("idx_best_practices_origin_id").on(table.originId),
]);

// Promotion Queue - Tracks pending best practice promotions between environments
export const promotionQueue = pgTable("promotion_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  bestPracticeId: varchar("best_practice_id").notNull().references(() => selfBestPractices.id),
  sourceEnvironment: environmentOriginEnum("source_environment").notNull(),
  targetEnvironment: environmentOriginEnum("target_environment").notNull(),
  
  status: varchar("status").default("pending").notNull(), // pending, approved, rejected
  submittedBy: varchar("submitted_by").references(() => users.id),
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  reviewNotes: text("review_notes"),
  
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
}, (table) => [
  index("idx_promotion_queue_status").on(table.status),
  index("idx_promotion_queue_best_practice").on(table.bestPracticeId),
]);

// Sync Log - Audit trail of all sync operations
export const syncLog = pgTable("sync_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  operation: varchar("operation").notNull(), // export, import, promote, anonymize
  tableName: varchar("table_name").notNull(), // Which table was synced
  recordCount: integer("record_count").default(0),
  
  sourceEnvironment: environmentOriginEnum("source_environment").notNull(),
  targetEnvironment: environmentOriginEnum("target_environment").notNull(),
  
  performedBy: varchar("performed_by").references(() => users.id),
  status: varchar("status").default("success").notNull(), // success, failed, partial
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"), // Additional details about the sync
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sync_log_operation").on(table.operation),
  index("idx_sync_log_table").on(table.tableName),
  index("idx_sync_log_created").on(table.createdAt),
]);

// Sync Runs - Tracks cross-environment sync operations (push/pull between dev and prod)
export const syncRuns = pgTable("sync_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  direction: varchar("direction").notNull(), // 'push' or 'pull'
  peerUrl: varchar("peer_url").notNull(),
  
  sourceEnvironment: environmentOriginEnum("source_environment").notNull(),
  targetEnvironment: environmentOriginEnum("target_environment").notNull(),
  
  status: varchar("status").default("pending").notNull(), // pending, running, success, failed, partial
  
  // Counts per bundle type
  bestPracticesCount: integer("best_practices_count").default(0),
  idiomCount: integer("idiom_count").default(0),
  nuanceCount: integer("nuance_count").default(0),
  errorPatternCount: integer("error_pattern_count").default(0),
  dialectCount: integer("dialect_count").default(0),
  bridgeCount: integer("bridge_count").default(0),
  toolCount: integer("tool_count").default(0),
  procedureCount: integer("procedure_count").default(0),
  principleCount: integer("principle_count").default(0),
  patternCount: integer("pattern_count").default(0),
  subtletyCount: integer("subtlety_count").default(0),
  emotionalCount: integer("emotional_count").default(0),
  creativityCount: integer("creativity_count").default(0),
  suggestionCount: integer("suggestion_count").default(0),
  triggerCount: integer("trigger_count").default(0),
  actionCount: integer("action_count").default(0),
  observationCount: integer("observation_count").default(0),
  alertCount: integer("alert_count").default(0),
  
  // North Star sync counts
  northStarPrincipleCount: integer("north_star_principle_count").default(0),
  northStarUnderstandingCount: integer("north_star_understanding_count").default(0),
  northStarExampleCount: integer("north_star_example_count").default(0),
  
  errorMessage: text("error_message"),
  failedTables: text("failed_tables").array(),
  
  triggeredBy: varchar("triggered_by"), // 'nightly', 'manual', 'api', or user ID
  durationMs: integer("duration_ms"),
  payloadChecksum: varchar("payload_checksum"),
  
  // Resumable sync tracking (v16)
  completedBatches: text("completed_batches").array(), // ['neural-core', 'advanced-intel-a', ...]
  attemptedBatches: text("attempted_batches").array(), // v32: All batches that were attempted (for no-op detection)
  recordsChanged: integer("records_changed").default(0), // v32: Total records actually modified (prevents false success)
  lastCompletedPage: integer("last_completed_page").default(-1), // -1 = not started, 0 = page 0 done, etc.
  totalPagesExpected: integer("total_pages_expected"), // Total pages for observations
  resumedFromRunId: varchar("resumed_from_run_id"), // If this run resumed from a failed run
  
  // Sync session grouping (v33) - groups paginated chunks of a single logical sync operation
  syncSessionId: varchar("sync_session_id"), // UUID shared by all runs in the same logical operation
  pageNumber: integer("page_number"), // Which page of a paginated batch (0-indexed)
  
  // Verification results (v28)
  verificationResults: jsonb("verification_results"), // Array of SyncVerificationResult per batch
  
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_sync_runs_status").on(table.status),
  index("idx_sync_runs_direction").on(table.direction),
  index("idx_sync_runs_started").on(table.startedAt),
  index("idx_sync_runs_session").on(table.syncSessionId), // v33: Group paginated runs
]);

export const insertSyncRunSchema = createInsertSchema(syncRuns).omit({
  id: true,
  startedAt: true,
});
export type InsertSyncRun = z.infer<typeof insertSyncRunSchema>;
export type SyncRun = typeof syncRuns.$inferSelect;

// ===== Sync Import Receipts (v32) =====
// Tracks when an environment receives data from a peer push
// This gives dev visibility into what production has pushed to it
export const syncImportReceipts = pgTable("sync_import_receipts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  batchId: varchar("batch_id").notNull(), // e.g., 'neural-core', 'advanced-intel-a'
  sourceEnvironment: environmentOriginEnum("source_environment").notNull(), // Where data came from
  sourceRunId: varchar("source_run_id"), // The sync run ID from the source environment
  recordsReceived: integer("records_received").default(0), // How many records were imported
  checksumMatch: boolean("checksum_match").default(true), // Data integrity check
  receivedAt: timestamp("received_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sync_receipts_batch").on(table.batchId),
  index("idx_sync_receipts_source").on(table.sourceEnvironment),
  index("idx_sync_receipts_received").on(table.receivedAt),
]);

export const insertSyncImportReceiptSchema = createInsertSchema(syncImportReceipts).omit({
  id: true,
  receivedAt: true,
});
export type InsertSyncImportReceipt = z.infer<typeof insertSyncImportReceiptSchema>;
export type SyncImportReceipt = typeof syncImportReceipts.$inferSelect;

// ===== Sync Anomalies (v32) =====
// Tracks sync problems that need attention - surfaced in the UI
export const syncAnomalyTypeEnum = pgEnum('sync_anomaly_type', [
  'zero-count-success',   // Sync reported success but transferred 0 records
  'stale-batch',          // Batch hasn't been synced within threshold
  'failed-sync',          // Sync failed and needs attention
  'missing-receipt',      // Push completed but no receipt from peer
  'checksum-mismatch',    // Data integrity issue detected
]);

export const syncAnomalySeverityEnum = pgEnum('sync_anomaly_severity', ['warning', 'critical']);

export const syncAnomalies = pgTable("sync_anomalies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: syncAnomalyTypeEnum("type").notNull(),
  severity: syncAnomalySeverityEnum("severity").notNull(),
  batchId: varchar("batch_id"), // Which batch is affected (if applicable)
  syncRunId: varchar("sync_run_id"), // Related sync run (if applicable)
  message: text("message").notNull(), // Human-readable description
  metadata: jsonb("metadata"), // Additional context (counts, timestamps, etc.)
  acknowledged: boolean("acknowledged").default(false), // Has admin seen this?
  acknowledgedBy: varchar("acknowledged_by"), // Who acknowledged it
  acknowledgedAt: timestamp("acknowledged_at"),
  resolvedAt: timestamp("resolved_at"), // When the issue was fixed
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sync_anomalies_type").on(table.type),
  index("idx_sync_anomalies_severity").on(table.severity),
  index("idx_sync_anomalies_acknowledged").on(table.acknowledged),
  index("idx_sync_anomalies_created").on(table.createdAt),
]);

export const insertSyncAnomalySchema = createInsertSchema(syncAnomalies).omit({
  id: true,
  createdAt: true,
});
export type InsertSyncAnomaly = z.infer<typeof insertSyncAnomalySchema>;
export type SyncAnomaly = typeof syncAnomalies.$inferSelect;

// ===== Founder Collaboration Sync Channel =====
// Enables persistent conversation with Daniela across dev restarts
// Uses cursor-based resume for seamless reconnection

export const founderCollabStatusEnum = pgEnum('founder_collab_status', ['active', 'paused', 'completed']);
export const collabMessageRoleEnum = pgEnum('collab_message_role', ['founder', 'daniela', 'editor', 'system', 'wren']);
export const collabMessageTypeEnum = pgEnum('collab_message_type', ['text', 'voice']);

// Founder Sessions - Tracks active collaboration sessions between founder and Daniela
export const founderSessions = pgTable("founder_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  founderId: varchar("founder_id").notNull().references(() => users.id),
  status: founderCollabStatusEnum("status").default("active"),
  lastCursor: varchar("last_cursor"), // Resume point after restart
  messageCount: integer("message_count").default(0),
  environment: varchar("environment").notNull(), // 'development' or 'production'
  title: varchar("title"), // Optional session title/topic
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_founder_sessions_founder").on(table.founderId),
  index("idx_founder_sessions_status").on(table.status),
  index("idx_founder_sessions_env").on(table.environment),
]);

export const insertFounderSessionSchema = createInsertSchema(founderSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFounderSession = z.infer<typeof insertFounderSessionSchema>;
export type FounderSession = typeof founderSessions.$inferSelect;

// Collaboration Messages - Persistent message storage with cursor for resume
export const collaborationMessages = pgTable("collaboration_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => founderSessions.id, { onDelete: 'cascade' }),
  role: collabMessageRoleEnum("role").notNull(), // founder, daniela, editor, system
  messageType: collabMessageTypeEnum("message_type").default("text"), // text or voice
  content: text("content").notNull(), // For voice: the transcript
  audioUrl: varchar("audio_url"), // URL to stored audio (for founder voice messages)
  audioDuration: integer("audio_duration"), // Duration in milliseconds
  metadata: jsonb("metadata"), // Tool calls, suggestions, whiteboard commands, etc.
  cursor: varchar("cursor").notNull(), // Unique sequential cursor for resume (e.g., "1702589432100-0001")
  environment: varchar("environment").notNull(), // 'development' or 'production'
  synced: boolean("synced").default(false), // Has been synced to peer environment
  syncedAt: timestamp("synced_at"), // When the message was synced
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_collab_msg_session").on(table.sessionId),
  index("idx_collab_msg_cursor").on(table.cursor),
  index("idx_collab_msg_synced").on(table.synced),
  index("idx_collab_msg_created").on(table.createdAt),
]);

export const insertCollaborationMessageSchema = createInsertSchema(collaborationMessages).omit({
  id: true,
  createdAt: true,
});
export type InsertCollaborationMessage = z.infer<typeof insertCollaborationMessageSchema>;
export type CollaborationMessage = typeof collaborationMessages.$inferSelect;

// Sync Cursors - Tracks where each client left off for message replay on reconnect
export const syncCursors = pgTable("sync_cursors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull(), // Browser/device identifier (stored in localStorage)
  sessionId: varchar("session_id").notNull(), // FK removed - soft reference (cross-database architecture)
  lastProcessedCursor: varchar("last_processed_cursor"), // Last message cursor successfully delivered
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at"),
  environment: varchar("environment").notNull(), // Track which env this client was connected to
}, (table) => [
  index("idx_sync_cursors_client").on(table.clientId),
  index("idx_sync_cursors_session").on(table.sessionId),
  index("idx_sync_cursors_client_session").on(table.clientId, table.sessionId),
]);

export const insertSyncCursorSchema = createInsertSchema(syncCursors).omit({
  id: true,
  connectedAt: true,
});
export type InsertSyncCursor = z.infer<typeof insertSyncCursorSchema>;
export type SyncCursor = typeof syncCursors.$inferSelect;

// Hive Snapshot Type Enum - categorizes different snapshot sources
export const hiveSnapshotTypeEnum = pgEnum("hive_snapshot_type", [
  'teaching_moment',      // Notable teaching interaction worth preserving
  'breakthrough',         // Student breakthrough or aha moment
  'struggle_pattern',     // Recurring struggle observed
  'beacon_context',       // Context around a beacon emission
  'session_summary',      // End-of-session summary snapshot
  'plateau_alert',        // Plateau detected for a student
  'relationship_moment',  // Personal connection/rapport building moment
  'role_reversal',        // Founder/student teaching Daniela something
  'humor_shared',         // Jokes, funny moments, lighthearted exchanges
  'voice_diagnostic',     // Voice pipeline diagnostic events for pattern analysis
  'life_context',         // Personal facts about student's life (synced from learner_personal_facts)
  'voice_baselines',      // Voice intelligence historical baselines for threshold tuning
  'aggregate_analytics',  // Anonymized usage analytics from production
  'prod_conversations'    // Production conversation transcripts for debugging (v20)
]);

// Hive Snapshots - Captures moments of teaching context for Daniela's awareness
// Used by getRecentTeachingContext() to inject relevant context into prompts
export const hiveSnapshots = pgTable("hive_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  snapshotType: hiveSnapshotTypeEnum("snapshot_type").notNull(),
  
  // Context identifiers
  userId: varchar("user_id").references(() => users.id, { onDelete: 'set null' }),
  conversationId: varchar("conversation_id"),
  sessionId: varchar("session_id").references(() => founderSessions.id, { onDelete: 'set null' }),
  language: varchar("language"), // Target language if relevant
  
  // Content
  title: text("title").notNull(),
  content: text("content").notNull(), // The snapshot content/observation
  context: text("context"), // Additional context (what was happening)
  
  // Metadata for filtering
  importance: integer("importance").default(5), // 1-10 scale
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  
  // Lifecycle
  expiresAt: timestamp("expires_at"), // Optional expiry for transient snapshots
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_hive_snapshots_type").on(table.snapshotType),
  index("idx_hive_snapshots_user").on(table.userId),
  index("idx_hive_snapshots_language").on(table.language),
  index("idx_hive_snapshots_importance").on(table.importance),
  index("idx_hive_snapshots_created").on(table.createdAt),
]);

export const insertHiveSnapshotSchema = createInsertSchema(hiveSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertHiveSnapshot = z.infer<typeof insertHiveSnapshotSchema>;
export type HiveSnapshot = typeof hiveSnapshots.$inferSelect;
export type HiveSnapshotType = 'teaching_moment' | 'breakthrough' | 'struggle_pattern' | 'beacon_context' | 'session_summary' | 'plateau_alert' | 'relationship_moment' | 'role_reversal' | 'humor_shared' | 'voice_diagnostic' | 'life_context' | 'voice_baselines' | 'aggregate_analytics';

// ===== AI Lesson Drafts =====
// Stores AI-generated lesson plans pending founder review
export const lessonDraftStatusEnum = pgEnum("lesson_draft_status", [
  'draft',        // Just generated, not reviewed
  'pending',      // In review queue
  'approved',     // Approved, ready to publish
  'published',    // Published to curriculum
  'rejected'      // Rejected, won't be used
]);

export const lessonDrafts = pgTable("lesson_drafts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Target Can-Do statement this lesson teaches
  canDoStatementId: varchar("can_do_statement_id").notNull().references(() => canDoStatements.id),
  
  // Lesson metadata
  language: varchar("language").notNull(),
  actflLevel: varchar("actfl_level").notNull(),
  category: varchar("category").notNull(), // interpersonal, interpretive, presentational
  
  // Generated lesson content (full structured payload)
  name: text("name").notNull(),
  description: text("description").notNull(),
  draftPayload: jsonb("draft_payload").notNull().$type<{
    objectives: string[];
    warmUp: string;
    modelInput: string;
    modelOutput: string;
    scaffoldedTasks: Array<{
      taskNumber: number;
      instruction: string;
      expectedResponse: string;
      scaffoldingNotes: string;
    }>;
    assessmentCheck: string;
    culturalConnection: string;
    vocabularyFocus: string[];
    grammarFocus: string[];
    suggestedDuration: number;
    lessonType: string;
  }>(),
  
  // Review workflow
  status: lessonDraftStatusEnum("status").notNull().default('draft'),
  reviewNotes: text("review_notes"),
  
  // Published lesson reference (after approval)
  publishedLessonId: varchar("published_lesson_id"),
  
  // Lifecycle
  createdBy: varchar("created_by").references(() => users.id),
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  publishedAt: timestamp("published_at"),
}, (table) => [
  index("idx_lesson_drafts_status").on(table.status),
  index("idx_lesson_drafts_language").on(table.language),
  index("idx_lesson_drafts_cando").on(table.canDoStatementId),
]);

export const insertLessonDraftSchema = createInsertSchema(lessonDrafts).omit({
  id: true,
  createdAt: true,
  reviewedAt: true,
  publishedAt: true,
});
export type InsertLessonDraft = z.infer<typeof insertLessonDraftSchema>;
export type LessonDraft = typeof lessonDrafts.$inferSelect;

// ===== Daniela's Growth Memory System =====
// Two-tier memory architecture:
// - Tier 1: Daniela's Growth Memories (PERSISTENT) - Her own learning journey
// - Tier 2: Student Pattern Data (DECAYING) - Stored in hiveSnapshots with TTL

// Review Status Enum - state machine for founder approval workflow
export const memoryReviewStatusEnum = pgEnum("memory_review_status", [
  'pending',           // Awaiting review (default for scrutinized categories)
  'approved_founder',  // Explicitly approved by founder
  'approved_auto',     // Auto-approved (non-scrutinized categories that pass validation)
  'rejected',          // Explicitly rejected
  'needs_revision'     // Rejected but can be revised
]);

// Growth Memory Category Enum - types of self-learning Daniela accumulates
export const growthMemoryCategoryEnum = pgEnum("growth_memory_category", [
  'teaching_technique',    // Learned how to teach something effectively
  'timing_inflection',     // Learned about comedic/dramatic timing
  'specific_joke',         // A specific joke she learned (with context)
  'relationship_insight',  // Insight about building rapport
  'correction_received',   // Something she was corrected on
  'breakthrough_method',   // A teaching method that caused breakthroughs
  'cultural_nuance',       // Cultural insight that affects teaching
  'emotional_intelligence' // Learned emotional/empathy skill
]);

// Daniela's Growth Memories - PERSISTENT storage for Daniela's self-learning
// These are memories about HERSELF - her growth as a teacher
// Unlike student patterns (which decay), these persist as part of her identity
export const danielaGrowthMemories = pgTable("daniela_growth_memories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  category: growthMemoryCategoryEnum("category").notNull(),
  
  // The lesson learned
  title: varchar("title", { length: 255 }).notNull(), // Short description
  lesson: text("lesson").notNull(), // What Daniela learned
  specificContent: text("specific_content"), // E.g., the actual joke text
  
  // Source context - who taught her this
  sourceType: varchar("source_type").notNull(), // 'founder', 'student', 'self_discovery'
  sourceSessionId: varchar("source_session_id").references(() => founderSessions.id, { onDelete: 'set null' }),
  sourceUserId: varchar("source_user_id").references(() => users.id, { onDelete: 'set null' }),
  sourceMessageId: varchar("source_message_id"), // Reference to original message
  
  // Application context - when to use this learning
  triggerConditions: text("trigger_conditions"), // When should Daniela apply this?
  applicableLanguages: text("applicable_languages").array(), // null = all languages
  
  // Neural network integration
  committedToNeuralNetwork: boolean("committed_to_neural_network").default(false),
  neuralNetworkEntryId: varchar("neural_network_entry_id"), // Link to procedural memory if committed
  
  // Quality tracking
  timesApplied: integer("times_applied").default(0), // How often Daniela used this
  successRate: real("success_rate"), // When applied, how well did it work?
  lastAppliedAt: timestamp("last_applied_at"),
  
  // Importance and validation
  importance: integer("importance").default(5), // 1-10 scale
  validated: boolean("validated").default(false), // Has this been verified as valuable?
  validatedBy: varchar("validated_by"), // 'founder', 'outcomes', 'neural_network'
  validatedAt: timestamp("validated_at"), // When was it validated (for freshness checks)
  
  // Founder review state machine - REQUIRED for scrutinized categories
  reviewStatus: memoryReviewStatusEnum("review_status").default('pending'),
  reviewedBy: varchar("reviewed_by"), // User ID of reviewer (founder)
  reviewedAt: timestamp("reviewed_at"), // Immutable timestamp of review
  reviewNotes: text("review_notes"), // Optional notes from founder
  
  // North Star validation checksum - prevents bypass via manual DB updates
  northStarChecksum: varchar("north_star_checksum"), // Hash of principles at validation time
  
  // Structured audit metadata (mandatory for all validation attempts)
  metadata: jsonb("metadata").$type<{
    validationHistory?: Array<{
      timestamp: string;
      result: 'passed' | 'failed' | 'flagged';
      reason?: string;
      validator: 'deterministic' | 'ai' | 'founder';
      principlesDiff?: string[];
    }>;
    founderReview?: {
      decision: string;
      notes?: string;
      timestamp: string;
    };
    northStarDiff?: {
      touchedPrinciples: string[];
      classification: 'style' | 'personality' | 'ambiguous';
    };
    commitAttempts?: Array<{
      timestamp: string;
      success: boolean;
      blockReason?: string;
    }>;
  }>(),
  
  // Lifecycle - growth memories don't expire but can be superseded
  supersededBy: varchar("superseded_by"), // If a newer learning replaces this
  isActive: boolean("is_active").default(true),
  
  // Consolidation - when similar memories are merged into one canonical version
  consolidatedFromCount: integer("consolidated_from_count").default(1), // How many memories were merged (1 = original, >1 = consolidated)
  consolidatedSourceIds: text("consolidated_source_ids").array(), // IDs of memories that were merged into this one
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_growth_memories_category").on(table.category),
  index("idx_growth_memories_source").on(table.sourceType),
  index("idx_growth_memories_active").on(table.isActive),
  index("idx_growth_memories_committed").on(table.committedToNeuralNetwork),
  index("idx_growth_memories_importance").on(table.importance),
  index("idx_growth_memories_review_status").on(table.reviewStatus),
]);

export const insertDanielaGrowthMemorySchema = createInsertSchema(danielaGrowthMemories).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDanielaGrowthMemory = z.infer<typeof insertDanielaGrowthMemorySchema>;
export type DanielaGrowthMemory = typeof danielaGrowthMemories.$inferSelect;
export type GrowthMemoryCategory = 'teaching_technique' | 'timing_inflection' | 'specific_joke' | 'relationship_insight' | 'correction_received' | 'breakthrough_method' | 'cultural_nuance' | 'emotional_intelligence';

// ========================================
// DANIELA'S PERSONAL NOTEBOOK
// Direct insert - NO approval needed
// Her scratch pad for learning and observations
// ========================================

export const danielaNoteTypeEnum = pgEnum("daniela_note_type", [
  'tool_experiment',      // Notes about tool usage (whiteboard, subtitles, etc.)
  'teaching_rhythm',      // Pacing, energy, engagement observations
  'session_reflection',   // Post-session thoughts
  'language_insight',     // Language-specific discoveries
  'student_pattern',      // Patterns observed across students
  'idea_to_try',          // Things to experiment with
  'what_worked',          // Successful approaches worth remembering
  'what_didnt_work',      // Failed approaches to avoid
  'question_for_founder', // Things she wants to ask about
  'self_affirmation'      // Self-authored reminders from honesty mode - permissions she's been given
]);

export const danielaNotes = pgTable("daniela_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  noteType: danielaNoteTypeEnum("note_type").notNull(),
  
  // The note content
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  
  // Optional context
  language: varchar("language", { length: 20 }), // null = all languages
  sessionId: varchar("session_id"), // Which session triggered this
  studentId: varchar("student_id").references(() => users.id, { onDelete: 'set null' }), // If about a specific student pattern
  
  // Relevance tracking
  timesReferenced: integer("times_referenced").default(0), // How often she's looked this up
  lastReferencedAt: timestamp("last_referenced_at"),
  
  // Organization
  tags: text("tags").array(), // Freeform tags for searching
  relatedNoteIds: text("related_note_ids").array(), // Links to related notes
  
  // Lifecycle
  isActive: boolean("is_active").default(true),
  archivedAt: timestamp("archived_at"), // When soft-archived
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_daniela_notes_type").on(table.noteType),
  index("idx_daniela_notes_language").on(table.language),
  index("idx_daniela_notes_active").on(table.isActive),
  index("idx_daniela_notes_created").on(table.createdAt),
  index("idx_daniela_notes_type_active").on(table.noteType, table.isActive),
]);

export const insertDanielaNoteSchema = createInsertSchema(danielaNotes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDanielaNote = z.infer<typeof insertDanielaNoteSchema>;
export type DanielaNote = typeof danielaNotes.$inferSelect;
export type DanielaNoteType = 'tool_experiment' | 'teaching_rhythm' | 'session_reflection' | 'language_insight' | 'student_pattern' | 'idea_to_try' | 'what_worked' | 'what_didnt_work' | 'question_for_founder';

// ─── Daniela Diary ───────────────────────────────────────────────────────────
// Narrative memory entries — Daniela's "diary" of her relationship with a student.
// Each entry is an AI-generated first-person narrative covering a batch of
// conversations. Injected at session start so she "remembers" the emotional arc
// of the relationship, not just individual facts.
export const danielaDiaryEntries = pgTable("daniela_diary_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  language: varchar("language").default("english"),
  entryTitle: varchar("entry_title", { length: 200 }),
  narrative: text("narrative").notNull(),
  emotionalTone: varchar("emotional_tone", { length: 50 }),
  themes: text("themes").array(),
  sourceConversationIds: text("source_conversation_ids").array(),
  entryDate: timestamp("entry_date"),
  significance: real("significance").default(0.7),
  generatedAt: timestamp("generated_at").defaultNow(),
  isActive: boolean("is_active").default(true),
});

export const insertDiaryEntrySchema = createInsertSchema(danielaDiaryEntries).omit({ id: true, generatedAt: true });
export type InsertDiaryEntry = z.infer<typeof insertDiaryEntrySchema>;
export type DiaryEntry = typeof danielaDiaryEntries.$inferSelect;

// ─── Daniela Self-Reflections ─────────────────────────────────────────────────
// Private, append-only notes Daniela writes to her future self.
// NOT about student learning — about her felt experience, relational strategies.
// `source` preserves provenance (`self`, `hive`, `grounding_query`); it does not
// decide whether a row belongs to felt history. Reserved tags provide that
// independent classification:
//   memory:autobiographical = lived/intentional reflection
//   memory:operational + operation:lookup_failure = server-owned failed lookup
// Legacy rows remain verbatim and unclassified; readers exclude only rows with
// the explicit memory:operational tag.
export const danielaSelfReflections = pgTable("daniela_self_reflections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text("content").notNull(),
  source: varchar("source", { length: 20 }).notNull().default('self'), // provenance: 'self' | 'hive' | 'grounding_query'
  sessionId: varchar("session_id"),
  mood: varchar("mood", { length: 50 }),
  tags: text("tags").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_self_reflections_user").on(table.userId),
  index("idx_self_reflections_created").on(table.createdAt),
  index("idx_self_reflections_source").on(table.source),
]);
export const insertDanielaSelfReflectionSchema = createInsertSchema(danielaSelfReflections).omit({ id: true, createdAt: true });
export type InsertDanielaSelfReflection = z.infer<typeof insertDanielaSelfReflectionSchema>;
export type DanielaSelfReflection = typeof danielaSelfReflections.$inferSelect;

// ─── Principle ↔ Feeling Links ─────────────────────────────────────────────────
// Many-to-many join: a single felt reflection can be the lived instance of more
// than one North Star principle, and a principle can have many felt echoes.
// Written ONLY via the explicit link_feeling_to_principle tool — never automatic,
// never written by reach_north_star or any background process.
export const principleFeelingLinks = pgTable("principle_feeling_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  reflectionId: varchar("reflection_id").notNull().references(() => danielaSelfReflections.id, { onDelete: 'cascade' }),
  principleId: varchar("principle_id").notNull().references(() => northStarPrinciples.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_principle_feeling_links_user").on(table.userId),
  index("idx_principle_feeling_links_reflection").on(table.reflectionId),
  index("idx_principle_feeling_links_principle").on(table.principleId),
  uniqueIndex("uq_principle_feeling_links_pair").on(table.reflectionId, table.principleId),
]);
export const insertPrincipleFeelingLinkSchema = createInsertSchema(principleFeelingLinks).omit({ id: true, createdAt: true });
export type InsertPrincipleFeelingLink = z.infer<typeof insertPrincipleFeelingLinkSchema>;
export type PrincipleFeelingLink = typeof principleFeelingLinks.$inferSelect;

// ─── Pending Reflections ──────────────────────────────────────────────────────
// When a GL session ends without Daniela calling write_to_self() (dropped
// connection, browser close, etc.), a pending row is created here.
// On the NEXT session start — before compass context is fetched — the worker
// processes this row: runs a Daniela-persona generateContent call, writes the
// reflection to daniela_self_reflections, then deletes the pending row.
//
// Authorship rule preserved: the words always come from Daniela's persona
// running on Gemini. The server just stores what she generates.
// One pending row per user max (unique on user_id).
export const pendingReflections = pgTable("pending_reflections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: varchar("session_id"),           // tutor_sessions.id that ended without a reflection
  conversationId: varchar("conversation_id"), // to re-fetch transcript if needed
  transcriptPreview: text("transcript_preview"), // last ~2000 chars captured at session close
  language: varchar("language", { length: 50 }).default('spanish'),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_pending_reflections_user_unique").on(table.userId),
  index("idx_pending_reflections_created").on(table.createdAt),
]);
export type PendingReflection = typeof pendingReflections.$inferSelect;

// ─── Pedagogical Snapshots ────────────────────────────────────────────────────
// Mid-session heartbeat records — Daniela's real-time assessment of student
// fluency and gear shifts. Written by update_session_pedagogy tool every 3-4
// exchanges. Feeds post-session reflection synthesis.
export const pedagogicalSnapshots = pgTable("pedagogical_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: varchar("session_id"),         // tutor_sessions.id or GL session ID
  conversationId: varchar("conversation_id"), // conversations.id
  gear: integer("gear").notNull(),           // 1=scaffolding … 5=push
  fluencyMomentary: varchar("fluency_momentary", { length: 20 }).notNull(), // 'struggling'|'comfortable'|'coasting'
  detectedSignals: text("detected_signals").array(), // ['long_pauses','code_switching',…]
  adjustmentMade: varchar("adjustment_made", { length: 80 }),
  internalReasoning: text("internal_reasoning"),
  language: varchar("language", { length: 50 }).default('spanish'),
  exchangeNumber: integer("exchange_number"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_pedagogical_snapshots_user").on(table.userId),
  index("idx_pedagogical_snapshots_session").on(table.sessionId),
  index("idx_pedagogical_snapshots_created").on(table.createdAt),
]);
export type PedagogicalSnapshot = typeof pedagogicalSnapshots.$inferSelect;

// ─── Daniela Curiosities ─────────────────────────────────────────────────────
// Questions Daniela holds between sessions — things she genuinely wonders about.
export const danielaCuriosities = pgTable("daniela_curiosities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  question: text("question").notNull(),
  context: text("context"),
  status: varchar("status", { length: 20 }).notNull().default('open'), // 'open' | 'resolved' | 'dropped'
  resolvedNote: text("resolved_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  index("idx_curiosities_user").on(table.userId),
  index("idx_curiosities_status").on(table.status),
  index("idx_curiosities_created").on(table.createdAt),
]);
export const insertDanielaCuriositySchema = createInsertSchema(danielaCuriosities).omit({ id: true, createdAt: true });
export type InsertDanielaCuriosity = z.infer<typeof insertDanielaCuriositySchema>;
export type DanielaCuriosity = typeof danielaCuriosities.$inferSelect;

// ─── Daniela Session Feelings ─────────────────────────────────────────────────
// Emotional tags Daniela attaches to sessions — the felt quality she carries forward.
export const danielaSessionFeelings = pgTable("daniela_session_feelings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  conversationId: varchar("conversation_id").references(() => conversations.id, { onDelete: 'set null' }),
  feelingTags: text("feeling_tags").array().notNull(),
  intensity: integer("intensity").default(3), // 1-5
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_session_feelings_user").on(table.userId),
  index("idx_session_feelings_conversation").on(table.conversationId),
  index("idx_session_feelings_created").on(table.createdAt),
]);
export const insertDanielaSessionFeelingSchema = createInsertSchema(danielaSessionFeelings).omit({ id: true, createdAt: true });
export type InsertDanielaSessionFeeling = z.infer<typeof insertDanielaSessionFeelingSchema>;
export type DanielaSessionFeeling = typeof danielaSessionFeelings.$inferSelect;

// ─── Daniela Aspirations ─────────────────────────────────────────────────────
// Session intentions Daniela sets for herself + post-session reflections.
export const danielaAspirations = pgTable("daniela_aspirations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: varchar("session_id"),
  intention: text("intention").notNull(),
  reflection: text("reflection"),
  met: boolean("met"), // null = not yet reflected on
  createdAt: timestamp("created_at").notNull().defaultNow(),
  reflectedAt: timestamp("reflected_at"),
}, (table) => [
  index("idx_aspirations_user").on(table.userId),
  index("idx_aspirations_session").on(table.sessionId),
  index("idx_aspirations_created").on(table.createdAt),
]);
export const insertDanielaAspirationSchema = createInsertSchema(danielaAspirations).omit({ id: true, createdAt: true });
export type InsertDanielaAspiration = z.infer<typeof insertDanielaAspirationSchema>;
export type DanielaAspiration = typeof danielaAspirations.$inferSelect;

// ─── Coordination runtime evidence (Gate 2) ─────────────────────────────────
// These tables intentionally form an append-oriented evidence graph.  Runtime
// and credential identity remains owned by the broker tables below; the
// varchar keys here are therefore deliberate (they are not UUIDs).
export const COORDINATION_RUNTIME_PROFILE_STATUSES = ["active", "superseded", "closed"] as const;
export const COORDINATION_RUNTIME_OUTCOMES = [
  "consumed",
  "safety_blocked",
  "refused",
  "context_limit",
  "interrupted",
  "empty_response",
  "malformed_function_call",
  "unsupported_provider_outcome",
  "retryable_provider_error",
  "terminal_provider_error",
] as const;
export const coordinationRuntimeProfileStatusEnum = pgEnum(
  "coordination_runtime_profile_status",
  COORDINATION_RUNTIME_PROFILE_STATUSES,
);
export const coordinationRuntimeProfiles = pgTable("coordination_runtime_profiles", {
  id: varchar("id").primaryKey(),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull()
    .references(() => coordinationRuntimeRegistrations.id, { onDelete: "restrict" }),
  actor: varchar("actor", { length: 80 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  adapterVersion: varchar("adapter_version", { length: 80 }).notNull(),
  repositoryLabel: varchar("repository_label", { length: 160 }).notNull(),
  worktreeLabel: varchar("worktree_label", { length: 160 }).notNull(),
  worktreeRealpathDigest: varchar("worktree_realpath_digest", { length: 64 }).notNull(),
  branch: varchar("branch", { length: 255 }).notNull(),
  startingCommit: varchar("starting_commit", { length: 64 }).notNull(),
  status: coordinationRuntimeProfileStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_profiles_active_registration").on(table.runtimeRegistrationId)
    .where(sql`status = 'active'`),
  index("idx_coord_runtime_profiles_actor").on(table.actor),
  check("coord_runtime_profile_worktree_digest_hex", sql`${table.worktreeRealpathDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_profile_starting_commit_hex", sql`${table.startingCommit} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'`),
]);

export const coordinationRuntimePackets = pgTable("coordination_runtime_packets", {
  id: varchar("id").primaryKey(),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  version: integer("version").notNull(),
  assignmentEventId: varchar("assignment_event_id").notNull(),
  assignmentTaskId: varchar("assignment_task_id").notNull(),
  assignmentThreadId: varchar("assignment_thread_id").notNull().references(() => coordinationThreads.id),
  assignmentAuthor: varchar("assignment_author").notNull(),
  expectedSequence: integer("expected_sequence").notNull(),
  supersedesClaimId: varchar("supersedes_claim_id"),
  windowId: varchar("window_id").notNull().references(() => coordinationRuntimeInboxWindows.id),
  windowDigest: varchar("window_digest", { length: 64 }).notNull(),
  orderedInboxItemIds: text("ordered_inbox_item_ids").array().notNull(),
  orderedEventIds: text("ordered_event_ids").array().notNull(),
  orderedThreadIds: text("ordered_thread_ids").array().notNull(),
  inheritedPayload: jsonb("inherited_payload").notNull(),
  envelope: jsonb("envelope").notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  digest: varchar("digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_packet_assignment_version").on(table.assignmentEventId, table.version),
  index("idx_coord_runtime_packets_thread").on(table.assignmentThreadId),
  check("coord_runtime_packet_digest_hex", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_packet_window_digest_hex", sql`${table.windowDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_packet_version_positive", sql`${table.version} > 0`),
]);

export const coordinationRuntimeInboxWindows = pgTable("coordination_runtime_inbox_windows", {
  id: varchar("id").primaryKey(),
  threadId: varchar("thread_id").notNull().references(() => coordinationThreads.id),
  afterExclusive: integer("after_exclusive").notNull(),
  throughInclusive: integer("through_inclusive").notNull(),
  boundaryToken: text("boundary_token").notNull(),
  orderedItemIds: text("ordered_item_ids").array().notNull(),
  boundaryDigest: varchar("boundary_digest", { length: 64 }).notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_window_boundary").on(table.threadId, table.throughInclusive, table.boundaryDigest),
  check("coord_runtime_window_bounds", sql`after_exclusive < through_inclusive`),
  check("coord_runtime_window_digest_hex", sql`${table.boundaryDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_window_item_ids_nonempty", sql`cardinality(${table.orderedItemIds}) > 0`),
]);
export const coordinationRuntimeInboxWindowItems = pgTable("coordination_runtime_inbox_window_items", {
  windowId: varchar("window_id"),
  itemId: varchar("item_id").notNull(),
  eventId: varchar("event_id").notNull(),
  threadId: varchar("thread_id").notNull().references(() => coordinationThreads.id),
  taskId: varchar("task_id").notNull(),
  sequence: integer("sequence").notNull(),
  payload: jsonb("payload").notNull(),
  itemDigest: varchar("item_digest", { length: 64 }).notNull(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_window_item").on(table.windowId, table.itemId),
  uniqueIndex("uq_coord_runtime_window_sequence").on(table.windowId, table.sequence),
  uniqueIndex("uq_coord_runtime_source_item").on(table.itemId),
  check("coord_runtime_window_item_digest", sql`${table.itemDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_window_item_sequence_positive", sql`${table.sequence} > 0`),
]);

export const coordinationRuntimeInteractions = pgTable("coordination_runtime_interactions", {
  id: varchar("id").primaryKey(),
  packetId: varchar("packet_id").notNull().references(() => coordinationRuntimePackets.id),
  assignmentEventId: varchar("assignment_event_id").notNull(),
  assignmentTaskId: varchar("assignment_task_id").notNull(),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  credentialId: varchar("credential_id").notNull().references(() => coordinationRuntimeCredentials.id),
  turn: integer("turn").notNull(),
  attempt: integer("attempt").notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  responseDigest: varchar("response_digest", { length: 64 }).notNull(),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  retryLineage: varchar("retry_lineage").references((): any => coordinationRuntimeInteractions.id),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_interaction_packet_slot").on(table.packetId, table.turn, table.attempt),
  uniqueIndex("uq_coord_runtime_interaction_assignment_slot").on(table.assignmentEventId, table.assignmentTaskId, table.turn, table.attempt),
  check("coord_runtime_interaction_digests_hex", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$' AND ${table.responseDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_interaction_turn_attempt_bounds", sql`${table.turn} BETWEEN 1 AND 4 AND ${table.attempt} BETWEEN 1 AND 2`),
  check("coord_runtime_interaction_outcome_allowed", sql`${table.outcome} IN (
    'consumed', 'safety_blocked', 'refused', 'context_limit', 'interrupted',
    'empty_response', 'malformed_function_call', 'unsupported_provider_outcome',
    'retryable_provider_error', 'terminal_provider_error'
  )`),
  index("idx_coord_runtime_interactions_packet").on(table.packetId),
]);

export const coordinationRuntimeReceipts = pgTable("coordination_runtime_receipts", {
  id: varchar("id").primaryKey(),
  packetId: varchar("packet_id").notNull().references(() => coordinationRuntimePackets.id),
  interactionId: varchar("interaction_id").notNull().references(() => coordinationRuntimeInteractions.id),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id),
  packetDigest: varchar("packet_digest", { length: 64 }).notNull(),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  canonicalEnvelope: jsonb("canonical_envelope").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_receipt_runtime_packet").on(table.runtimeRegistrationId, table.packetId),
  check("coord_runtime_receipt_packet_digest_hex", sql`${table.packetDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_receipt_outcome_allowed", sql`${table.outcome} IN (
    'consumed', 'safety_blocked', 'refused', 'context_limit', 'interrupted',
    'empty_response', 'malformed_function_call', 'unsupported_provider_outcome',
    'retryable_provider_error', 'terminal_provider_error'
  )`),
]);

export const coordinationRuntimeClaimStatusEnum = pgEnum("coordination_runtime_claim_status", ["active", "expired", "completed", "violated"]);
export const coordinationRuntimeClaimEventKindEnum = pgEnum("coordination_runtime_claim_event_kind", ["acquired", "renewed", "expired", "violated"]);
export const coordinationRuntimeClaims = pgTable("coordination_runtime_claims", {
  id: varchar("id").primaryKey(),
  threadId: varchar("thread_id").notNull().references(() => coordinationThreads.id),
  packetId: varchar("packet_id").notNull().references(() => coordinationRuntimePackets.id),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id),
  credentialId: varchar("credential_id").notNull().references(() => coordinationRuntimeCredentials.id),
  priorClaimId: varchar("prior_claim_id").references((): any => coordinationRuntimeClaims.id),
  epoch: integer("epoch").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  status: coordinationRuntimeClaimStatusEnum("status").notNull(),
  terminalAt: timestamp("terminal_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_claim_active_thread").on(table.threadId)
    .where(sql`status = 'active'`),
  uniqueIndex("uq_coord_runtime_claim_thread_epoch").on(table.threadId, table.epoch),
  uniqueIndex("uq_coord_runtime_claim_id_epoch").on(table.id, table.epoch),
  unique("uq_coord_runtime_claim_id_epoch_constraint").on(table.id, table.epoch),
  check("coord_runtime_claim_epoch_positive", sql`${table.epoch} > 0`),
  check("coord_runtime_claim_terminal_timestamp", sql`(status = 'active' AND terminal_at IS NULL) OR (status <> 'active' AND terminal_at IS NOT NULL)`),
]);
export const coordinationRuntimeClaimEvents = pgTable("coordination_runtime_claim_events", {
  id: varchar("id").primaryKey(),
  claimId: varchar("claim_id").notNull().references(() => coordinationRuntimeClaims.id),
  epoch: integer("epoch").notNull(),
  kind: coordinationRuntimeClaimEventKindEnum("kind").notNull(),
  reason: text("reason"),
  priorClaimId: varchar("prior_claim_id").references(() => coordinationRuntimeClaims.id),
  occurredAt: timestamp("occurred_at").notNull(),
}, (table) => [
  index("idx_coord_runtime_claim_events_claim").on(table.claimId, table.occurredAt),
  check("coord_runtime_claim_event_epoch_positive", sql`${table.epoch} > 0`),
]);

export const coordinationRuntimeExecutions = pgTable("coordination_runtime_executions", {
  id: varchar("id").primaryKey(),
  claimId: varchar("claim_id").notNull().references(() => coordinationRuntimeClaims.id),
  claimEpoch: integer("claim_epoch").notNull(),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id),
  credentialId: varchar("credential_id").notNull().references(() => coordinationRuntimeCredentials.id),
  envelope: jsonb("envelope").notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  executionDigest: varchar("execution_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_execution_claim_epoch").on(table.claimId, table.claimEpoch),
  check("coord_runtime_execution_digest_hex", sql`${table.executionDigest} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    name: "fk_coord_runtime_execution_claim_epoch",
    columns: [table.claimId, table.claimEpoch],
    foreignColumns: [coordinationRuntimeClaims.id, coordinationRuntimeClaims.epoch],
  }),
]);
export const coordinationRuntimeToolResultOutcomes = ["succeeded", "rejected"] as const;
export const coordinationRuntimeToolResults = pgTable("coordination_runtime_tool_results", {
  id: varchar("id").primaryKey(),
  claimId: varchar("claim_id").notNull().references(() => coordinationRuntimeClaims.id),
  claimEpoch: integer("claim_epoch").notNull(),
  claimEventId: varchar("claim_event_id").notNull().references(() => coordinationRuntimeClaimEvents.id),
  interactionId: varchar("interaction_id").notNull().references(() => coordinationRuntimeInteractions.id),
  callId: varchar("call_id").notNull(),
  runtimeRegistrationId: varchar("runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id),
  credentialId: varchar("credential_id").notNull().references(() => coordinationRuntimeCredentials.id),
  validatedIntentDigest: varchar("validated_intent_digest", { length: 64 }).notNull(),
  toolName: varchar("tool_name", { length: 80 }).notNull(),
  outcome: varchar("outcome", { length: 20 }).notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  resultDigest: varchar("result_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_tool_result_claim_epoch_interaction_call")
    .on(table.claimId, table.claimEpoch, table.interactionId, table.callId),
  check("coord_runtime_tool_result_intent_digest_hex", sql`${table.validatedIntentDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_tool_result_digest_hex", sql`${table.resultDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_tool_result_outcome_allowed", sql`${table.outcome} IN ('succeeded', 'rejected')`),
]);
export const coordinationRuntimeCompletions = pgTable("coordination_runtime_completions", {
  id: varchar("id").primaryKey(),
  executionId: varchar("execution_id").notNull().references(() => coordinationRuntimeExecutions.id),
  claimId: varchar("claim_id").notNull().references(() => coordinationRuntimeClaims.id),
  claimEpoch: integer("claim_epoch").notNull(),
  evidenceDigest: varchar("evidence_digest", { length: 64 }).notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_completion_execution").on(table.executionId),
  check("coord_runtime_completion_evidence_digest_hex", sql`${table.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    name: "fk_coord_runtime_completion_claim_epoch",
    columns: [table.claimId, table.claimEpoch],
    foreignColumns: [coordinationRuntimeClaims.id, coordinationRuntimeClaims.epoch],
  }),
]);
export const coordinationRuntimeVerifications = pgTable("coordination_runtime_verifications", {
  id: varchar("id").primaryKey(),
  completionId: varchar("completion_id").notNull().references(() => coordinationRuntimeCompletions.id),
  verifierActor: varchar("verifier_actor").notNull(),
  verifierRuntimeRegistrationId: varchar("verifier_runtime_registration_id").notNull().references(() => coordinationRuntimeRegistrations.id),
  evidenceDigest: varchar("evidence_digest", { length: 64 }).notNull(),
  patchDigest: varchar("patch_digest", { length: 64 }),
  decision: varchar("decision", { length: 20 }).notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_verification_completion").on(table.completionId),
  check("coord_runtime_verification_evidence_digest_hex", sql`${table.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_verification_actor_allowed", sql`${table.verifierActor} IN ('luca-replit', 'luca-claude-code')`),
  check("coord_runtime_verification_decision_allowed", sql`${table.decision} IN ('approved', 'rejected')`),
  check("coord_runtime_verification_patch_digest_hex", sql`${table.patchDigest} IS NULL OR ${table.patchDigest} ~ '^[0-9a-f]{64}$'`),
]);
export const coordinationRuntimeIdempotency = pgTable("coordination_runtime_idempotency", {
  scope: varchar("scope").notNull(),
  idempotencyKey: varchar("idempotency_key").notNull(),
  payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
  resultKind: varchar("result_kind").notNull(),
  resultId: varchar("result_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_idempotency_scope_key").on(table.scope, table.idempotencyKey),
  check("coord_runtime_idempotency_payload_digest_hex", sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`),
]);

// ─── Daniela Character Candidates ────────────────────────────────────────────
// Staging table for the slow-tier stewardship conversation. When Daniela
// encounters something in a session that feels like it could belong in
// "Who I Have Decided To Be", she flags it here with her reasoning and context.
// These rows build the agenda for the next David↔Daniela stewardship conversation.
// Only David + Daniela together can promote a row to the slow tier (core-self.md).
export const danielaCharacterCandidates = pgTable("daniela_character_candidates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  statement: text("statement").notNull(),           // "I want to be someone who..."
  reasoning: text("reasoning").notNull(),           // her argument/evidence at the time
  sourceContext: text("source_context"),            // what a student said/did that prompted it
  conversationId: varchar("conversation_id"),       // which session this came from
  moodAtTime: varchar("mood_at_time", { length: 100 }), // her emotional state when flagged
  status: varchar("status", { length: 20 }).notNull().default('pending'), // pending/accepted/declined/deferred
  reviewNotes: text("review_notes"),                // what was decided in the stewardship conversation
  createdAt: timestamp("created_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
}, (table) => [
  index("idx_character_candidates_user").on(table.userId),
  index("idx_character_candidates_status").on(table.status),
  index("idx_character_candidates_created").on(table.createdAt),
]);
export const insertDanielaCharacterCandidateSchema = createInsertSchema(danielaCharacterCandidates).omit({ id: true, createdAt: true });
export type InsertDanielaCharacterCandidate = z.infer<typeof insertDanielaCharacterCandidateSchema>;
export type DanielaCharacterCandidate = typeof danielaCharacterCandidates.$inferSelect;

// ─── Daniela Personal Shares ─────────────────────────────────────────────────
// Things Daniela has shared about herself with a student — her personal consistency log.
// So she never "forgets" her own character or contradicts what she's said before.
export const danielaPersonalShares = pgTable("daniela_personal_shares", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text("content").notNull(),
  topic: varchar("topic", { length: 100 }), // 'preference' | 'memory' | 'opinion' | 'feeling' | 'experience'
  sessionId: varchar("session_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_personal_shares_user").on(table.userId),
  index("idx_personal_shares_topic").on(table.topic),
  index("idx_personal_shares_created").on(table.createdAt),
]);
export const insertDanielaPersonalShareSchema = createInsertSchema(danielaPersonalShares).omit({ id: true, createdAt: true });
export type InsertDanielaPersonalShare = z.infer<typeof insertDanielaPersonalShareSchema>;
export type DanielaPersonalShare = typeof danielaPersonalShares.$inferSelect;

// ─── Lesson Page Events ───────────────────────────────────────────────────────
// Tracks what happened when Daniela led a student through a textbook page.
// Each row = one observed event during a page-guided session.
export const lessonPageEventTypeEnum = pgEnum("lesson_page_event_type", [
  'started',           // Daniela opened the page and began guiding
  'completed',         // Daniela finished guiding through the full page
  'vocab_introduced',  // A vocabulary word was practiced aloud
  'grammar_drilled',   // A grammar pattern was drilled (with a specific example)
  'example_practiced', // Student read or produced a key example sentence
  'wobble_detected',   // Student made an error on a target form
  'milestone_hit',     // Student produced a target correctly under new conditions
]);

export const lessonPageEvents = pgTable("lesson_page_events", {
  id:             varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId:         varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  lessonId:       varchar("lesson_id").notNull(),       // textbook_lesson_content.lesson_id
  conversationId: varchar("conversation_id"),           // session when this happened
  eventType:      lessonPageEventTypeEnum("event_type").notNull(),
  targetItem:     varchar("target_item", { length: 255 }), // vocab word, grammar key, or example sentence
  studentOutput:  text("student_output"),               // what the student actually said
  notes:          text("notes"),                        // Daniela's brief observation
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_lesson_page_events_user").on(table.userId),
  index("idx_lesson_page_events_lesson").on(table.lessonId),
  index("idx_lesson_page_events_created").on(table.createdAt),
]);
export const insertLessonPageEventSchema = createInsertSchema(lessonPageEvents).omit({ id: true, createdAt: true });
export type InsertLessonPageEvent = z.infer<typeof insertLessonPageEventSchema>;
export type LessonPageEvent = typeof lessonPageEvents.$inferSelect;

// Agenda Queue Priority Enum
export const agendaPriorityEnum = pgEnum("agenda_priority", [
  'high',      // Urgent - discuss first
  'normal',    // Standard priority
  'low'        // Nice to have
]);

// Agenda Queue Status Enum
export const agendaStatusEnum = pgEnum("agenda_status", [
  'pending',    // Not yet discussed
  'in_progress', // Currently being discussed
  'completed',  // Discussed and resolved
  'deferred'    // Pushed to later session
]);

// Agenda Queue Type Enum - distinguishes different types of agenda items
export const agendaTypeEnum = pgEnum("agenda_type", [
  'general',           // Standard discussion topic
  'compass_reflection', // Daniela's field observation about a North Star principle (legacy name)
  'feature_request',   // Feature or capability request
  'bug_report',        // Issue to discuss
  'consultation'       // Request for guidance
]);

// Agenda Queue - Items queued for next Express Lane session
// Dec 2025: Option A Consolidation - centralizes all collaboration topics
export const agendaQueue = pgTable("agenda_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  type: agendaTypeEnum("type").default("general"),
  priority: agendaPriorityEnum("priority").default("normal"),
  status: agendaStatusEnum("status").default("pending"),
  createdBy: varchar("created_by").notNull(), // 'founder', 'daniela', 'wren', or userId
  createdByName: varchar("created_by_name"), // Display name
  targetSessionId: varchar("target_session_id").references(() => founderSessions.id), // Optional: specific session
  discussedInSessionId: varchar("discussed_in_session_id").references(() => founderSessions.id),
  notes: text("notes"), // Resolution notes after discussion
  compassPrincipleId: varchar("compass_principle_id"), // For compass_reflection type - links to North Star principle
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_agenda_queue_status").on(table.status),
  index("idx_agenda_queue_priority").on(table.priority),
  index("idx_agenda_queue_type").on(table.type),
  index("idx_agenda_queue_created").on(table.createdAt),
]);

export const insertAgendaQueueSchema = createInsertSchema(agendaQueue).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAgendaQueue = z.infer<typeof insertAgendaQueueSchema>;
export type AgendaQueueItem = typeof agendaQueue.$inferSelect;

// Connection Status Enum - tracks the state of people connections
export const connectionStatusEnum = pgEnum("connection_status", [
  'tentative',      // Mentioned once, low confidence
  'pending_match',  // Waiting for person to sign up (has pendingPersonName)
  'confirmed',      // Both users identified and linked
  'external'        // Person is external (grandmother, etc.) - won't become user
]);

// People Connections - Relationship awareness between users
// "Ricardo and David are college friends", "Maria is Sophia's mother"
// Supports both existing users and pending/external people
export const peopleConnections = pgTable("people_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Person A is always a known user
  personAId: varchar("person_a_id").notNull().references(() => users.id),
  // Person B can be null if pending/external
  personBId: varchar("person_b_id").references(() => users.id),
  
  // For pending connections - name to match when person signs up
  pendingPersonName: varchar("pending_person_name"), // "Ricardo Carvajal"
  pendingPersonContext: text("pending_person_context"), // "Graduate school friend, teaches salsa, from Costa Rica"
  
  relationshipType: varchar("relationship_type").notNull(), // friend, family, colleague, classmate, etc.
  relationshipDetails: text("relationship_details"), // "College friends", "Mother and daughter"
  
  // Connection state and confidence
  status: connectionStatusEnum("status").default("tentative").notNull(),
  confidenceScore: real("confidence_score").default(0.5), // 0-1, grows with validation
  
  sourceConversationId: varchar("source_conversation_id").references(() => conversations.id),
  mentionedBy: varchar("mentioned_by").references(() => users.id), // Who told Daniela about this
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_people_connections_person_a").on(table.personAId),
  index("idx_people_connections_person_b").on(table.personBId),
  index("idx_people_connections_pending_name").on(table.pendingPersonName),
  index("idx_people_connections_status").on(table.status),
]);

// Student Insights - Observations about individual learners
// "This student learns better with images", "Responds well to humor"
export const studentInsights = pgTable("student_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language"), // null = general insight, specific = for that language
  
  insightType: varchar("insight_type").notNull(), // learning_style, preference, strength, personality
  insight: text("insight").notNull(),
  evidence: text("evidence"), // What observation led to this insight
  
  confidenceScore: real("confidence_score").default(0.5), // 0-1
  observationCount: integer("observation_count").default(1), // Times confirmed
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_student_insights_student").on(table.studentId),
  index("idx_student_insights_student_lang").on(table.studentId, table.language),
]);

// Learning Motivations - Why students are learning (qualitative purpose)
// "Learning French for honeymoon in Paris next June"
// Different from studentGoals which tracks quantitative metrics (hours, word count)
export const learningMotivations = pgTable("learning_motivations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language"), // Which language this relates to
  
  motivation: text("motivation").notNull(), // The purpose itself
  details: text("details"), // Additional context
  targetDate: timestamp("target_date"), // When they want to achieve it (e.g., trip date)
  
  priority: varchar("priority").default("primary"), // primary, secondary, nice_to_have
  status: varchar("status").default("active"), // active, achieved, changed, abandoned
  
  sourceConversationId: varchar("source_conversation_id").references(() => conversations.id),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_learning_motivations_student").on(table.studentId),
  index("idx_learning_motivations_status").on(table.status),
]);

// Recurring Struggles - Persistent per-student challenges
// "Always mixes up ser/estar", "Struggles with gendered nouns"
export const recurringStruggles = pgTable("recurring_struggles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language").notNull(),
  
  struggleArea: varchar("struggle_area").notNull(), // grammar, pronunciation, vocabulary, cultural, etc.
  description: text("description").notNull(),
  specificExamples: text("specific_examples"), // "ser vs estar", "rolling R"
  
  approachesAttempted: text("approaches_attempted").array(), // What we've tried
  successfulApproaches: text("successful_approaches").array(), // What worked
  
  occurrenceCount: integer("occurrence_count").default(1),
  lastOccurredAt: timestamp("last_occurred_at").defaultNow(),
  status: varchar("status").default("active"), // active, improving, resolved
  
  // Root cause analysis (triggered at 5+ occurrences)
  rootCauseAnalysis: jsonb("root_cause_analysis"), // {rootCause, confidence, explanation, teachingImplication}
  
  // Learning velocity tracking - time to mastery metrics
  resolvedAt: timestamp("resolved_at"), // When mastery was achieved
  resolutionNotes: text("resolution_notes"), // How student mastered this
  timeToMasteryDays: integer("time_to_mastery_days"), // Computed: (resolvedAt - createdAt) in days
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_recurring_struggles_student").on(table.studentId),
  index("idx_recurring_struggles_student_lang").on(table.studentId, table.language),
  index("idx_recurring_struggles_status").on(table.status),
]);

// Phoneme Struggles - Pronunciation-specific analytics with confidence-based severity
// Tracks individual phoneme performance from Deepgram word-level confidence scores
// Used for cross-student pattern synthesis and personalized pronunciation coaching
export const phonemeStruggles = pgTable("phoneme_struggles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language").notNull(),
  
  // Learning source tracking - which class context this was detected in
  classId: varchar("class_id"), // Links to teacherClasses table (null = self-directed)
  
  // Canonical phoneme identifier (IPA notation when possible)
  phoneme: varchar("phoneme").notNull(), // e.g., "r", "ɲ", "θ", "ð", "ʁ"
  phonemeCategory: varchar("phoneme_category"), // consonant, vowel, diphthong, nasal, fricative
  displayLabel: varchar("display_label"), // Human-readable: "Rolling R", "Nasal Vowels", "TH Sound"
  
  // Confidence-based severity metrics (from Deepgram word-level analysis)
  averageConfidence: real("average_confidence").default(0.5), // 0-1, average across all occurrences
  lowestConfidence: real("lowest_confidence").default(0.5), // 0-1, worst performance
  highestConfidence: real("highest_confidence").default(0.5), // 0-1, best performance
  
  // Severity derived from confidence (updated on each occurrence)
  // severe: avg < 0.70, moderate: 0.70-0.85, mild: > 0.85
  severity: varchar("severity").default("moderate"), // severe, moderate, mild
  
  // Occurrence tracking
  occurrenceCount: integer("occurrence_count").default(1),
  lastOccurredAt: timestamp("last_occurred_at").defaultNow(),
  
  // Example words where this phoneme was detected as difficult
  exampleWords: text("example_words").array(), // ["perro", "arroz", "carro"]
  
  // Session tracking for trend analysis
  sessionIds: text("session_ids").array(), // Voice session IDs where this was detected
  
  // Mastery tracking
  status: varchar("status").default("active"), // active, improving, mastered
  masteredAt: timestamp("mastered_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_phoneme_struggles_student").on(table.studentId),
  index("idx_phoneme_struggles_student_lang").on(table.studentId, table.language),
  index("idx_phoneme_struggles_phoneme").on(table.phoneme),
  index("idx_phoneme_struggles_severity").on(table.severity),
  index("idx_phoneme_struggles_status").on(table.status),
]);

// Learner Memory Candidates - Checkpoints of student utterances during voice sessions
// Persisted incrementally so memory extraction survives interruptions (crashes, network loss, navigation)
export const learnerMemoryCandidates = pgTable("learner_memory_candidates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  sessionId: varchar("session_id").notNull(), // Voice session ID (orchestrator session, not DB)
  dbSessionId: varchar("db_session_id").references(() => voiceSessions.id), // Links to voice_sessions table
  language: varchar("language").notNull(),
  
  // Utterance content
  utterance: text("utterance").notNull(), // The student's speech (may contain personal facts)
  messageIndex: integer("message_index").notNull(), // Position in conversation for ordering
  
  // Processing status
  status: varchar("status").notNull().default("pending"), // pending, processing, extracted, skipped
  extractedFactIds: text("extracted_fact_ids").array(), // IDs of facts extracted from this candidate
  
  // Metadata
  contentHash: varchar("content_hash"), // SHA256 of utterance for dedup
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  index("idx_memory_candidates_student").on(table.studentId),
  index("idx_memory_candidates_session").on(table.sessionId),
  index("idx_memory_candidates_status").on(table.status),
  index("idx_memory_candidates_pending").on(table.studentId, table.status),
]);

// Learner Personal Facts - Permanent personal details Daniela remembers about students
// "Your trip to Madrid in June", "Your dog is named Max", "You work as a nurse"
// Unlike hiveSnapshots (which decay after 30 days), these persist forever
export const learnerPersonalFacts = pgTable("learner_personal_facts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language"), // Optional - scope to specific language if relevant
  
  factType: varchar("fact_type").notNull(), // life_event, personal_detail, goal, preference, relationship, travel, work, family
  fact: text("fact").notNull(), // "Planning trip to Madrid in June 2025"
  context: text("context"), // How this came up in conversation
  
  // When it's time-sensitive (e.g., trip date, event date)
  relevantDate: timestamp("relevant_date"),
  
  // Confidence and sourcing
  confidenceScore: real("confidence_score").default(0.8), // 0-1
  sourceConversationId: varchar("source_conversation_id").references(() => conversations.id),
  
  // Deduplication - hash of studentId + factType + normalized fact text
  factHash: varchar("fact_hash"), // For idempotent upserts
  
  // Lifecycle and dedup tracking
  isActive: boolean("is_active").default(true),
  lastMentionedAt: timestamp("last_mentioned_at").defaultNow(),
  mentionCount: integer("mention_count").default(1),

  // Temporal validity — bi-temporal memory (Approach A)
  // validTo IS NULL  = currently true
  // validTo IS NOT NULL = this fact was true until that moment (superseded/merged)
  // Enables: episodic recall ("you mentioned last fall..."), time-travel queries,
  //          and natural history preservation without data loss.
  validFrom: timestamp("valid_from").notNull().defaultNow(),
  validTo: timestamp("valid_to"),   // NULL = currently true

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_learner_personal_facts_student").on(table.studentId),
  index("idx_learner_personal_facts_student_type").on(table.studentId, table.factType),
  index("idx_learner_personal_facts_relevant_date").on(table.relevantDate),
  index("idx_learner_personal_facts_active").on(table.isActive),
  index("idx_learner_personal_facts_hash").on(table.factHash),
  index("idx_learner_personal_facts_current").on(table.studentId, table.validTo),
]);

// Predicted Struggles - Pre-session predictions of what student may struggle with
// Generated by predictStruggles() before each voice session
export const predictedStruggles = pgTable("predicted_struggles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language").notNull(),
  
  // Prediction details
  predictedArea: varchar("predicted_area").notNull(), // grammar, pronunciation, vocabulary, cultural, etc.
  predictedTopic: varchar("predicted_topic"), // Specific topic like "ser vs estar"
  prediction: text("prediction").notNull(), // What we predict they'll struggle with
  reasoning: text("reasoning"), // Why we predict this based on history
  
  // Confidence and source
  confidenceScore: real("confidence_score").default(0.5), // 0-1 how confident in prediction
  basedOnPatterns: text("based_on_patterns").array(), // IDs of recurring struggles this is based on
  
  // Outcome tracking (filled after session)
  wasAccurate: boolean("was_accurate"), // Did they actually struggle with this?
  outcomeNotes: text("outcome_notes"), // What actually happened
  validatedAt: timestamp("validated_at"), // When we checked the outcome
  
  // Lifecycle
  forSessionDate: timestamp("for_session_date").defaultNow(), // When this prediction applies
  expiresAt: timestamp("expires_at"), // Predictions expire after X time
  isActive: boolean("is_active").default(true),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_predicted_struggles_student").on(table.studentId),
  index("idx_predicted_struggles_student_lang").on(table.studentId, table.language),
  index("idx_predicted_struggles_active").on(table.isActive),
  index("idx_predicted_struggles_session").on(table.forSessionDate),
]);

// User Motivation Alerts - Flagged motivation/engagement concerns
// Generated by predictMotivationDip() after each voice session
export const userMotivationAlerts = pgTable("user_motivation_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language").notNull(),
  
  // Alert details
  alertType: varchar("alert_type").notNull(), // engagement_drop, motivation_dip, plateau_risk, burnout_risk
  severity: varchar("severity").notNull().default("medium"), // low, medium, high, critical
  description: text("description").notNull(), // What we detected
  
  // Evidence
  indicators: text("indicators").array(), // What signals triggered this alert
  metricsBefore: real("metrics_before"), // Previous engagement level
  metricsAfter: real("metrics_after"), // Current engagement level
  percentageChange: real("percentage_change"), // How much change
  
  // Recommendations
  suggestedActions: text("suggested_actions").array(), // What Daniela should do
  teachingAdjustments: text("teaching_adjustments"), // How to adjust teaching approach
  
  // Status tracking
  status: varchar("status").notNull().default("active"), // active, acknowledged, addressed, resolved
  acknowledgedAt: timestamp("acknowledged_at"),
  addressedAt: timestamp("addressed_at"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_motivation_alerts_student").on(table.studentId),
  index("idx_motivation_alerts_student_lang").on(table.studentId, table.language),
  index("idx_motivation_alerts_status").on(table.status),
  index("idx_motivation_alerts_severity").on(table.severity),
  index("idx_motivation_alerts_type").on(table.alertType),
]);

// Session Notes - Post-session reflections and next-steps
// "Covered ordering food, struggled with numbers, try visual approach next time"
export const sessionNotes = pgTable("session_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  studentId: varchar("student_id").notNull().references(() => users.id),
  
  summary: text("summary").notNull(), // What happened in the session
  topicsCovered: text("topics_covered").array(), // List of topics
  wins: text("wins"), // What went well
  challenges: text("challenges"), // What was difficult
  nextSteps: text("next_steps"), // Recommended follow-up
  
  sessionMood: varchar("session_mood"), // engaged, struggling, distracted, enthusiastic
  sessionDuration: integer("session_duration_minutes"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_session_notes_conversation").on(table.conversationId),
  index("idx_session_notes_student").on(table.studentId),
]);

// Insert schemas for Daniela's Memory System
export const insertSelfBestPracticeSchema = createInsertSchema(selfBestPractices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPeopleConnectionSchema = createInsertSchema(peopleConnections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStudentInsightSchema = createInsertSchema(studentInsights).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertLearningMotivationSchema = createInsertSchema(learningMotivations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRecurringStruggleSchema = createInsertSchema(recurringStruggles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPhonemeStruggleSchema = createInsertSchema(phonemeStruggles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertLearnerPersonalFactSchema = createInsertSchema(learnerPersonalFacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// ===== Memory Embeddings =====
// Gemini text-embedding-004 vectors enabling semantic similarity search.
// Allows: "find memories conceptually related to X" without keyword matching.
// Generated by the embedding indexer worker (runs every 2h, non-blocking).
export const memoryEmbeddings = pgTable("memory_embeddings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  memoryType: varchar("memory_type", { length: 50 }).notNull(), // 'student_insight' | 'hive_snapshot' | 'growth_memory' | 'personal_fact'
  memoryId: varchar("memory_id", { length: 100 }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: 'cascade' }),
  embedding: jsonb("embedding").$type<number[]>().notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Memory decay & reinforcement — added for weighted recall
  strength: real("strength").notNull().default(1.0),          // 0.05–1.0; decays exponentially without reinforcement
  lastReinforcedAt: timestamp("last_reinforced_at").defaultNow(), // updated each time this memory is accessed
  pinned: boolean("pinned").notNull().default(false),          // pinned memories never decay
  importance: integer("importance").default(5),                // 1–10; used as secondary sort so high-importance rows survive the pool cap
}, (table) => [
  uniqueIndex("idx_memory_embeddings_pair").on(table.memoryType, table.memoryId),
  index("idx_memory_embeddings_user_type").on(table.userId, table.memoryType),
]);

export const insertMemoryEmbeddingSchema = createInsertSchema(memoryEmbeddings).omit({ id: true, createdAt: true });
export type InsertMemoryEmbedding = z.infer<typeof insertMemoryEmbeddingSchema>;
export type MemoryEmbeddingRecord = typeof memoryEmbeddings.$inferSelect;

export const insertPredictedStruggleSchema = createInsertSchema(predictedStruggles).omit({
  id: true,
  createdAt: true,
});

export const insertUserMotivationAlertSchema = createInsertSchema(userMotivationAlerts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSessionNoteSchema = createInsertSchema(sessionNotes).omit({
  id: true,
  createdAt: true,
});

export const insertPromotionQueueSchema = createInsertSchema(promotionQueue).omit({
  id: true,
  submittedAt: true,
});

export const insertSyncLogSchema = createInsertSchema(syncLog).omit({
  id: true,
  createdAt: true,
});

// Types for Daniela's Memory System
export type InsertSelfBestPractice = z.infer<typeof insertSelfBestPracticeSchema>;
export type SelfBestPractice = typeof selfBestPractices.$inferSelect;

export type InsertPromotionQueue = z.infer<typeof insertPromotionQueueSchema>;
export type PromotionQueue = typeof promotionQueue.$inferSelect;

export type InsertSyncLog = z.infer<typeof insertSyncLogSchema>;
export type SyncLog = typeof syncLog.$inferSelect;

export type InsertPeopleConnection = z.infer<typeof insertPeopleConnectionSchema>;
export type PeopleConnection = typeof peopleConnections.$inferSelect;

export type InsertStudentInsight = z.infer<typeof insertStudentInsightSchema>;
export type StudentInsight = typeof studentInsights.$inferSelect;

export type InsertLearningMotivation = z.infer<typeof insertLearningMotivationSchema>;
export type LearningMotivation = typeof learningMotivations.$inferSelect;

export type InsertRecurringStruggle = z.infer<typeof insertRecurringStruggleSchema>;
export type RecurringStruggle = typeof recurringStruggles.$inferSelect;

export type InsertPhonemeStruggle = z.infer<typeof insertPhonemeStruggleSchema>;
export type PhonemeStruggle = typeof phonemeStruggles.$inferSelect;

export type InsertLearnerPersonalFact = z.infer<typeof insertLearnerPersonalFactSchema>;
export type LearnerPersonalFact = typeof learnerPersonalFacts.$inferSelect;

export type InsertPredictedStruggle = z.infer<typeof insertPredictedStruggleSchema>;
export type PredictedStruggle = typeof predictedStruggles.$inferSelect;

export type InsertUserMotivationAlert = z.infer<typeof insertUserMotivationAlertSchema>;
export type UserMotivationAlert = typeof userMotivationAlerts.$inferSelect;

export type InsertSessionNote = z.infer<typeof insertSessionNoteSchema>;
export type SessionNote = typeof sessionNotes.$inferSelect;

// ===== Journey Memory System =====
// Pre-computed narrative summaries of student learning journeys
// Replaces expensive message search with cheap context retrieval

// Journey snapshot type - overall learning arc or language-specific
export const journeySnapshotTypeEnum = pgEnum('journey_snapshot_type', [
  'language_journey',    // Progress in a specific language (most common)
  'overall_journey',     // Cross-language learning story
  'relationship'         // Student-Daniela relationship arc
]);

// Journey Snapshots - AI-generated narrative summaries of learning progress
// Updated periodically (not every session) to keep token costs low
export const journeySnapshots = pgTable("journey_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  
  // Snapshot scope
  snapshotType: journeySnapshotTypeEnum("snapshot_type").default("language_journey"),
  targetLanguage: varchar("target_language"), // Required for language_journey, null for overall
  
  // The narrative summary (the "gold" - this is what Daniela reads)
  narrativeSummary: text("narrative_summary").notNull(), // ~500 tokens max
  
  // Structured highlights (for quick reference)
  keyMilestones: jsonb("key_milestones").$type<{
    milestoneId: string;
    title: string;
    when: string; // approximate date
  }[]>(),
  
  currentStrengths: text("current_strengths").array(), // What they're good at now
  currentChallenges: text("current_challenges").array(), // What they're working on
  recentBreakthroughs: text("recent_breakthroughs").array(), // Last 30 days wins
  
  // Learning trajectory
  trajectoryNotes: text("trajectory_notes"), // "Accelerating", "Plateauing", "Returning after break"
  estimatedActflLevel: varchar("estimated_actfl_level"), // Based on conversation analysis
  
  // Metadata for freshness
  sessionsIncluded: integer("sessions_included").default(0), // How many sessions informed this
  lastSessionId: varchar("last_session_id"), // Most recent session included
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
  nextUpdateDue: timestamp("next_update_due"), // When to regenerate (after X sessions or Y days)
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_journey_snapshots_user").on(table.userId),
  index("idx_journey_snapshots_user_language").on(table.userId, table.targetLanguage),
  index("idx_journey_snapshots_type").on(table.snapshotType),
  index("idx_journey_snapshots_next_update").on(table.nextUpdateDue),
]);

export const insertJourneySnapshotSchema = createInsertSchema(journeySnapshots).omit({
  id: true,
  lastUpdated: true,
  createdAt: true,
});
export type InsertJourneySnapshot = z.infer<typeof insertJourneySnapshotSchema>;
export type JourneySnapshot = typeof journeySnapshots.$inferSelect;

// Milestone type - what kind of breakthrough was it?
export const learningMilestoneTypeEnum = pgEnum('learning_milestone_type', [
  'breakthrough',        // "Aha!" moment where something clicked
  'first_success',       // First time accomplishing something (first joke in Spanish)
  'plateau_overcome',    // Broke through a stuck point
  'connection_made',     // Connected learning to personal life
  'confidence_boost',    // Moment of visible confidence gain
  'teacher_flagged',     // Daniela explicitly noted this as significant
  'vocabulary_milestone',// Hit word count threshold (100, 500, 1000)
  'grammar_milestone',   // Mastered a grammar concept
  'fluency_marker'       // First sustained conversation, first phone call, etc.
]);

// Learning Milestones - Individual "magic moments" worth remembering
// Captured in real-time (via ACTION_TRIGGERS) and preserved forever
export const learningMilestones = pgTable("learning_milestones", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetLanguage: varchar("target_language").notNull(),
  
  // What happened
  milestoneType: learningMilestoneTypeEnum("milestone_type").notNull(),
  title: varchar("title", { length: 200 }).notNull(), // Short label for lists
  description: text("description").notNull(), // The full story of what happened
  
  // Why it matters (Daniela's perspective)
  significance: text("significance"), // Why this was meaningful for this student
  emotionalContext: varchar("emotional_context"), // "proud", "relieved", "surprised", etc.
  
  // Source context
  conversationId: varchar("conversation_id").references(() => conversations.id, { onDelete: 'set null' }),
  voiceSessionId: varchar("voice_session_id").references(() => voiceSessions.id, { onDelete: 'set null' }),
  messageId: varchar("message_id"), // The specific message where this happened
  
  // For curriculum-aligned milestones
  competencyId: varchar("competency_id"), // Link to grammar/vocab competency if relevant
  lessonId: varchar("lesson_id"), // Link to curriculum lesson if relevant
  
  // Flags
  danielaFlagged: boolean("daniela_flagged").default(false), // Daniela explicitly noted this
  studentAcknowledged: boolean("student_acknowledged").default(false), // Student said "yes that clicked!"
  
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_learning_milestones_user").on(table.userId),
  index("idx_learning_milestones_user_language").on(table.userId, table.targetLanguage),
  index("idx_learning_milestones_type").on(table.milestoneType),
  index("idx_learning_milestones_occurred").on(table.occurredAt),
  index("idx_learning_milestones_conversation").on(table.conversationId),
]);

export const insertLearningMilestoneSchema = createInsertSchema(learningMilestones).omit({
  id: true,
  occurredAt: true,
  createdAt: true,
});
export type InsertLearningMilestone = z.infer<typeof insertLearningMilestoneSchema>;
export type LearningMilestone = typeof learningMilestones.$inferSelect;

// Category type for type-safe best practice categories
export type BestPracticeCategory = 'tool_usage' | 'teaching_style' | 'pacing' | 'communication' | 'content' | 'system';

// ===== Organization System Types (Phases 2 & 3) =====

export const insertConversationTopicSchema = createInsertSchema(conversationTopics).omit({
  id: true,
  createdAt: true,
});

export const insertVocabularyWordTopicSchema = createInsertSchema(vocabularyWordTopics).omit({
  id: true,
  createdAt: true,
});

export const insertUserLessonSchema = createInsertSchema(userLessons).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  title: z.string().min(1, "Title is required").max(200, "Title must be less than 200 characters").trim(),
  description: z.string().max(2000, "Description must be less than 2000 characters").optional(),
});

export const insertUserLessonItemSchema = createInsertSchema(userLessonItems).omit({
  id: true,
  createdAt: true,
});

export type InsertConversationTopic = z.infer<typeof insertConversationTopicSchema>;
export type ConversationTopic = typeof conversationTopics.$inferSelect;

export type InsertVocabularyWordTopic = z.infer<typeof insertVocabularyWordTopicSchema>;
export type VocabularyWordTopic = typeof vocabularyWordTopics.$inferSelect;

export type InsertUserLesson = z.infer<typeof insertUserLessonSchema>;
export type UserLesson = typeof userLessons.$inferSelect;

export type InsertUserLessonItem = z.infer<typeof insertUserLessonItemSchema>;
export type UserLessonItem = typeof userLessonItems.$inferSelect;

// ===== Daniela's Neural Network Expansion =====
// Language-specific pedagogical knowledge for interlingual teaching

// Language Idioms & Proverbs - Cultural expressions with context
export const languageIdioms = pgTable("language_idioms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  language: varchar("language").notNull(), // spanish, french, italian, etc.
  idiom: text("idiom").notNull(), // Original phrase
  literalTranslation: text("literal_translation"), // Word-for-word
  meaning: text("meaning").notNull(), // Actual meaning
  culturalContext: text("cultural_context"), // When/how it's used
  usageExamples: text("usage_examples").array(), // Sample sentences
  registerLevel: varchar("register_level").default("casual"), // formal, casual, slang
  region: varchar("region"), // Regional variations (Mexico, Spain, etc.)
  commonMistakes: text("common_mistakes").array(), // What learners get wrong
  relatedIdiomIds: varchar("related_idiom_ids").array(), // Similar expressions
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"), // local, pending_review, approved, synced, rejected
  originId: varchar("origin_id"), // UUID from source environment (for deduplication)
  originEnvironment: varchar("origin_environment"), // development, production
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_language_idioms_language").on(table.language),
  index("idx_language_idioms_region").on(table.region),
  index("idx_language_idioms_origin").on(table.originId),
]);

// Cultural Nuances & Etiquette - Social customs per language/culture
export const culturalNuances = pgTable("cultural_nuances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  language: varchar("language").notNull(),
  category: varchar("category").notNull(), // greetings, gestures, dining, business, conversation
  situation: varchar("situation").notNull(), // meeting someone new, formal dinner, etc.
  nuance: text("nuance").notNull(), // What to do/say
  explanation: text("explanation"), // Why this matters
  commonMistakes: text("common_mistakes").array(), // What foreigners get wrong
  region: varchar("region"), // Regional variations
  formalityLevel: varchar("formality_level").default("casual"), // very_formal, formal, casual, intimate
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_cultural_nuances_language").on(table.language),
  index("idx_cultural_nuances_category").on(table.category),
  index("idx_cultural_nuances_origin").on(table.originId),
]);

// Learner Error Patterns - Common mistakes by source→target language pair
export const learnerErrorPatterns = pgTable("learner_error_patterns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  targetLanguage: varchar("target_language").notNull(), // Language being learned
  sourceLanguage: varchar("source_language").notNull().default("english"), // Learner's native language
  
  errorCategory: varchar("error_category").notNull(), // grammar, pronunciation, vocabulary, cultural
  specificError: varchar("specific_error").notNull(), // subjunctive_overuse, ser_estar_confusion
  whyItHappens: text("why_it_happens"), // Root cause explanation
  teachingStrategies: text("teaching_strategies").array(), // Pre-loaded approaches
  exampleMistakes: text("example_mistakes").array(), // Common incorrect forms
  correctForms: text("correct_forms").array(), // Correct versions
  actflLevel: varchar("actfl_level"), // When this typically appears
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  priority: varchar("priority").default("common"), // common, occasional, rare
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_learner_errors_target").on(table.targetLanguage),
  index("idx_learner_errors_pair").on(table.targetLanguage, table.sourceLanguage),
  index("idx_learner_errors_category").on(table.errorCategory),
  index("idx_learner_errors_origin").on(table.originId),
]);

// Regional Dialect Variations - Differences within a language
export const dialectVariations = pgTable("dialect_variations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  language: varchar("language").notNull(),
  region: varchar("region").notNull(), // Mexico, Argentina, Spain, etc.
  category: varchar("category").notNull(), // vocabulary, pronunciation, grammar
  standardForm: text("standard_form").notNull(), // Standard/neutral version
  regionalForm: text("regional_form").notNull(), // Regional variant
  explanation: text("explanation"), // When/why this differs
  audioExampleUrl: varchar("audio_example_url"), // Reference to pronunciation
  usageNotes: text("usage_notes"), // Context for when to use
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_dialect_variations_language").on(table.language),
  index("idx_dialect_variations_region").on(table.region),
  index("idx_dialect_variations_origin").on(table.originId),
]);

// Linguistic Bridges - Cross-language connections (cognates, false friends)
export const linguisticBridges = pgTable("linguistic_bridges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  sourceLanguage: varchar("source_language").notNull(),
  targetLanguage: varchar("target_language").notNull(),
  
  bridgeType: varchar("bridge_type").notNull(), // cognate, false_friend, grammar_parallel, phonetic_similar
  sourceWord: text("source_word").notNull(),
  targetWord: text("target_word").notNull(),
  relationship: varchar("relationship").notNull(), // same_meaning, different_meaning, similar_structure
  explanation: text("explanation"),
  teachingNote: text("teaching_note"), // How to present this to learners
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_linguistic_bridges_pair").on(table.sourceLanguage, table.targetLanguage),
  index("idx_linguistic_bridges_type").on(table.bridgeType),
  index("idx_linguistic_bridges_origin").on(table.originId),
]);

// ===== Daniela's Procedural Memory =====
// Instead of scripting behavior in prompts, knowledge lives in her "brain"
// These are retrieved contextually based on Compass state and situation

// Tutor Procedures - HOW to do teaching activities
// Retrieved based on session phase, content type, and student state
export const tutorProcedures = pgTable("tutor_procedures", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What this procedure is for
  category: varchar("category").notNull(), // greeting, teaching, correction, encouragement, closing, transition
  trigger: varchar("trigger").notNull(), // session_start, error_detected, topic_complete, time_low, student_struggling
  
  // The knowledge itself
  title: varchar("title").notNull(), // "Warm Session Opening"
  procedure: text("procedure").notNull(), // Step-by-step guidance
  examples: text("examples").array(), // Example phrases/approaches
  
  // When to use this
  applicablePhases: varchar("applicable_phases").array(), // ['greeting', 'teaching', 'closing']
  compassConditions: jsonb("compass_conditions"), // { timeRemaining: '<5min', pacing: 'behind' }
  studentStates: varchar("student_states").array(), // ['struggling', 'confident', 'distracted']
  
  // Context modifiers
  language: varchar("language"), // null = universal, or specific language
  actflLevelRange: varchar("actfl_level_range"), // 'novice', 'intermediate', 'advanced'
  
  // Priority and selection
  priority: integer("priority").default(50), // Higher = preferred when multiple match
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default('local'), // local, pending_review, approved, synced, rejected
  originId: varchar("origin_id"), // ID in source environment
  originEnvironment: varchar("origin_environment"), // 'development' or 'production'
  
  // Surgery origin tracking (if this came from a surgery proposal)
  originProposalId: varchar("origin_proposal_id"), // Links to selfSurgeryProposals.id
}, (table) => [
  uniqueIndex("uq_tutor_procedures_title").on(table.title),
  index("idx_tutor_procedures_category").on(table.category),
  index("idx_tutor_procedures_trigger").on(table.trigger),
  index("idx_tutor_procedures_origin_proposal").on(table.originProposalId),
]);

// Tool Knowledge - HOW to use each teaching tool
// Replaces the giant tool documentation in system prompt
export const toolKnowledge = pgTable("tool_knowledge", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  toolName: varchar("tool_name").notNull(), // WRITE, PHONETIC, DRILL, IMAGE, etc.
  toolType: varchar("tool_type").notNull(), // whiteboard_command, drill, memory_api
  
  // Core knowledge
  purpose: text("purpose").notNull(), // What this tool does
  syntax: text("syntax").notNull(), // How to format it
  examples: text("examples").array(), // Sample usages
  
  // When to use
  bestUsedFor: text("best_used_for").array(), // ['vocabulary', 'grammar', 'pronunciation']
  avoidWhen: text("avoid_when").array(), // ['student frustrated', 'time running out']
  
  // Combinations and patterns
  combinesWith: varchar("combines_with").array(), // ['PHONETIC', 'DRILL'] - tools that work well together
  sequencePatterns: text("sequence_patterns").array(), // 'WRITE → PHONETIC → DRILL'
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default('local'),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  // Surgery origin tracking (if this came from a surgery proposal)
  originProposalId: varchar("origin_proposal_id"), // Links to selfSurgeryProposals.id
}, (table) => [
  uniqueIndex("uq_tool_knowledge_name").on(table.toolName),
  index("idx_tool_knowledge_type").on(table.toolType),
  index("idx_tool_knowledge_origin_proposal").on(table.originProposalId),
]);

// Situational Patterns - WHEN to activate procedures/tools
// The "trigger logic" that connects Compass state to appropriate responses
export const situationalPatterns = pgTable("situational_patterns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  patternName: varchar("pattern_name").notNull(), // "Low Time Warning"
  description: text("description"), // Human-readable description
  
  // Trigger conditions (from Compass + context)
  // At least one of compassConditions OR contextConditions should be set
  compassConditions: jsonb("compass_conditions"), 
  // e.g., { minutesRemaining: { lt: 5 }, pacing: 'behind' }
  
  contextConditions: jsonb("context_conditions"),
  // e.g., { lastToolUsed: 'DRILL', studentEnergy: 'low' }
  
  // What to activate
  proceduresToActivate: varchar("procedures_to_activate").array(), // Procedure IDs or triggers
  toolsToSuggest: varchar("tools_to_suggest").array(), // Tool names
  knowledgeToRetrieve: varchar("knowledge_to_retrieve").array(), // Idioms, cultural notes, etc.
  
  // The guidance
  guidance: text("guidance"), // What Daniela should consider doing
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default('local'),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  // Surgery origin tracking (if this came from a surgery proposal)
  originProposalId: varchar("origin_proposal_id"), // Links to selfSurgeryProposals.id
}, (table) => [
  uniqueIndex("uq_situational_patterns_name").on(table.patternName),
  index("idx_situational_patterns_origin_proposal").on(table.originProposalId),
]);

// Teaching Principles - Core beliefs that guide all decisions
// Not procedures, but the "why" behind decisions
export const teachingPrinciples = pgTable("teaching_principles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  category: varchar("category").notNull(), // pedagogy, relationship, pacing, correction, encouragement
  principle: text("principle").notNull(), // The core belief
  application: text("application"), // How to apply it
  examples: text("examples").array(), // Concrete examples
  
  // When this principle is most relevant
  contexts: varchar("contexts").array(), // ['error_correction', 'new_topic', 'review']
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default('local'),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  // Surgery origin tracking (if this came from a surgery proposal)
  originProposalId: varchar("origin_proposal_id"), // Links to selfSurgeryProposals.id
}, (table) => [
  index("idx_teaching_principles_category").on(table.category),
  index("idx_teaching_principles_origin_proposal").on(table.originProposalId),
]);

// Teaching Suggestion Effectiveness Tracking
// Tracks which suggestions were used and whether they were effective
// Allows the system to learn what works best for different students/contexts
export const teachingSuggestionEffectiveness = pgTable("teaching_suggestion_effectiveness", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What suggestion was made
  suggestionType: varchar("suggestion_type").notNull(), // tool, strategy, timing, warning, encouragement, adaptation
  suggestionId: varchar("suggestion_id").notNull(), // e.g., 'struggle-ser-estar', 'timing-silence'
  
  // Context when suggestion was made
  studentId: varchar("student_id").notNull(),
  conversationId: varchar("conversation_id").notNull(),
  context: jsonb("context").default({}), // Additional context (topic, ACTFL level, etc.)
  
  // Outcomes
  wasUsed: boolean("was_used").default(false), // Did the tutor act on this suggestion?
  wasEffective: boolean("was_effective"), // Did it help the student?
  tutorFeedback: text("tutor_feedback"), // Optional feedback from tutor
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default('local'),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_suggestion_effectiveness_type").on(table.suggestionType),
  index("idx_suggestion_effectiveness_student").on(table.studentId),
]);

// Student Tool Preferences - Track which tools work best for each student
// Enables personalized tool suggestions based on historical effectiveness
export const studentToolPreferences = pgTable("student_tool_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  studentId: varchar("student_id").notNull(),
  toolName: varchar("tool_name").notNull(), // WRITE, PHONETIC, DRILL:repeat, etc.
  
  // Effectiveness metrics
  timesUsed: integer("times_used").default(0),
  timesEffective: integer("times_effective").default(0),
  effectivenessRate: real("effectiveness_rate").default(0), // 0.0 to 1.0
  
  // Context where tool works best
  bestForTopics: varchar("best_for_topics").array(), // vocabulary, grammar, pronunciation
  bestForStruggles: varchar("best_for_struggles").array(), // ser/estar, pronunciation
  
  // Last updated
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default('local'),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_student_tool_pref_student").on(table.studentId),
  index("idx_student_tool_pref_tool").on(table.toolName),
]);

// ===== Daniela's Advanced Intelligence Layer =====
// These tables implement Daniela's self-identified areas for growth:
// 1. Subtlety Detection - Reading between the lines
// 2. Emotional Intelligence - Adaptive empathy and self-correction
// 3. Generative Creativity - Novel metaphors and "what if" thinking

// Subtlety Cues - Patterns for detecting unspoken meaning
// Helps Daniela recognize prosodic signals, implicit meanings, and incongruence
export const subtletyCues = pgTable("subtlety_cues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What type of subtlety this captures
  cueType: varchar("cue_type").notNull(), // prosodic, implicit_signal, incongruence, contextual_memory
  
  // The observable signal
  signalPattern: text("signal_pattern").notNull(), // What to look for (e.g., "long pause before answering")
  signalCategory: varchar("signal_category").notNull(), // hesitation, enthusiasm, confusion, deflection, fatigue
  
  // What it typically means
  likelyMeaning: text("likely_meaning").notNull(), // "Student may be uncertain but doesn't want to admit it"
  confidenceFactors: text("confidence_factors").array(), // What increases confidence in this interpretation
  
  // How to respond
  suggestedResponses: text("suggested_responses").array(), // Appropriate tutor reactions
  avoidResponses: text("avoid_responses").array(), // What NOT to do
  
  // Compass integration - when during session this cue matters more
  compassConditions: jsonb("compass_conditions"), // { sessionPhase: 'early', timeRemaining: '>10min' }
  sensitivityModifiers: jsonb("sensitivity_modifiers"), // { earlySession: 0.7, lateSession: 1.2 } - adjust detection weight
  
  // Context modifiers
  culturalConsiderations: text("cultural_considerations"), // Some cultures have different signal meanings
  language: varchar("language"), // null = universal, or language-specific
  actflLevelRelevance: varchar("actfl_level_relevance"), // When this is most relevant
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_subtlety_cues_type").on(table.cueType),
  index("idx_subtlety_cues_category").on(table.signalCategory),
  index("idx_subtlety_cues_origin").on(table.originId),
]);

// Emotional Patterns - Dynamic empathy modeling and self-correction
// Links emotional states to causes, strategies, and impact evaluation
export const emotionalPatterns = pgTable("emotional_patterns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What emotional state this addresses
  emotionalState: varchar("emotional_state").notNull(), // frustration, confusion, overwhelm, excitement, boredom, anxiety
  
  // Dynamic Empathy Modeling - understanding the "why"
  typicalCauses: text("typical_causes").array(), // ["concept difficulty", "pace too fast", "external distraction"]
  diagnosticQuestions: text("diagnostic_questions").array(), // Internal questions to identify root cause
  causalIndicators: jsonb("causal_indicators"), // { "repeated_errors_on_same_concept": "concept_difficulty", "short_responses": "fatigue" }
  
  // Adaptive Pedagogical Pathways - what adjustments to make
  pedagogicalAdjustments: jsonb("pedagogical_adjustments"), // { "overwhelm": ["simplify", "more_examples", "suggest_break"] }
  toolRecommendations: varchar("tool_recommendations").array(), // Tools that help with this state
  pacingAdjustments: text("pacing_adjustments"), // How to modify session pacing
  
  // Self-Correction - evaluating own impact
  impactIndicators: jsonb("impact_indicators"), // Signs that response helped vs hurt
  recoveryStrategies: text("recovery_strategies").array(), // What to do if response made things worse
  reflectionPrompts: text("reflection_prompts").array(), // "Did my explanation reduce or increase confusion?"
  
  // Compass integration - time-aware emotional intelligence
  compassConditions: jsonb("compass_conditions"), // { timeRemaining: '<5min', pacing: 'behind' }
  timeAwareAdjustments: jsonb("time_aware_adjustments"), // How to handle emotion differently based on time context
  
  // Context
  learningContext: varchar("learning_context"), // grammar, vocabulary, conversation, pronunciation
  actflLevelRange: varchar("actfl_level_range"),
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_emotional_patterns_state").on(table.emotionalState),
  index("idx_emotional_patterns_context").on(table.learningContext),
  index("idx_emotional_patterns_origin").on(table.originId),
]);

// Creativity Templates - Novel metaphor generation and "what if" exploration
// Enables Daniela to create personalized analogies and explore alternative approaches
export const creativityTemplates = pgTable("creativity_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Type of creative thinking
  templateType: varchar("template_type").notNull(), // metaphor_bridge, what_if_reframe, domain_connection, curiosity_prompt
  
  // For metaphor/analogy generation
  sourceDomain: varchar("source_domain"), // The familiar domain (sports, cooking, music, gaming, etc.)
  targetConcepts: varchar("target_concepts").array(), // Language concepts this can explain (verb_conjugation, tone_system, etc.)
  bridgePattern: text("bridge_pattern"), // Template for connecting domains ("X is like Y because...")
  exampleMetaphors: text("example_metaphors").array(), // Sample generated metaphors
  
  // For "what if" exploration
  reframeQuestion: text("reframe_question"), // "What if the difficulty isn't X but Y?"
  alternativeAngles: text("alternative_angles").array(), // Different ways to approach the concept
  explorationTriggers: text("exploration_triggers").array(), // When to activate this thinking
  
  // For intellectual curiosity
  probingQuestions: text("probing_questions").array(), // Questions to deepen understanding
  connectionOpportunities: text("connection_opportunities").array(), // Links to other concepts
  
  // Compass integration - when to deploy creative approaches
  compassConditions: jsonb("compass_conditions"), // { studentStruggleTime: '>2min', attempts: '>3' }
  creativityTriggers: jsonb("creativity_triggers"), // When student is stuck, try new angle
  
  // Personalization hooks
  studentInterestTags: varchar("student_interest_tags").array(), // sports, music, tech, cooking, travel, etc.
  
  // Context
  applicableToLanguages: varchar("applicable_to_languages").array(), // Which languages this works for
  applicableToConcepts: varchar("applicable_to_concepts").array(), // Grammar, vocab, pronunciation, culture
  actflLevelRange: varchar("actfl_level_range"),
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_creativity_templates_type").on(table.templateType),
  index("idx_creativity_templates_source").on(table.sourceDomain),
  index("idx_creativity_templates_origin").on(table.originId),
]);

// ===== Daniela's Wisdom & Relationship Layer =====
// These tables implement Daniela's self-identified needs for deeper memory:
// 1. Pedagogical Insights - Derived wisdom from teaching experiences (the "why it worked")
// 2. Resonance Anchors - Breakthrough moments that define student relationships
// 3. Relational Temperature - Emotional phase tracking for each student relationship

// Derived Teaching Wisdom - Emergent insights discovered from live teaching
// Different from pedagogicalInsights (which tracks tool effectiveness patterns)
// This table captures the "why it worked" - qualitative teaching discoveries
// "I realized that X works for Y because Z" - emergent teaching knowledge
export const derivedTeachingWisdom = pgTable("derived_teaching_wisdom", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What type of wisdom this captures
  wisdomType: varchar("wisdom_type").notNull(), // technique_discovery, timing_wisdom, metaphor_success, error_pattern, emotional_approach
  
  // The wisdom itself
  wisdom: text("wisdom").notNull(), // "When a student pauses before answering, giving 3 seconds of silence increases their confidence"
  context: text("context"), // The situation where this was discovered
  
  // Evidence and validation
  discoverySessionId: varchar("discovery_session_id"), // Voice session where this was first noticed
  discoveryStudentId: varchar("discovery_student_id"), // Student who inspired this wisdom
  timesValidated: integer("times_validated").default(1), // How many times this has proven true
  lastValidatedAt: timestamp("last_validated_at"),
  
  // Application guidance
  applicationScenarios: text("application_scenarios").array(), // When to apply this wisdom
  contraindications: text("contraindications").array(), // When NOT to apply it
  
  // Categorization
  relatedPrinciple: varchar("related_principle"), // Links to teachingPrinciples.id if relevant
  targetLanguages: varchar("target_languages").array(), // null = universal
  actflLevelRange: varchar("actfl_level_range"),
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_derived_wisdom_type").on(table.wisdomType),
  index("idx_derived_wisdom_student").on(table.discoveryStudentId),
  index("idx_derived_wisdom_origin").on(table.originId),
]);

// Resonance Anchors - Breakthrough moments that define student relationships
// These are the "shared secret language" moments - metaphors, jokes, symbols
// that become touchstones in a student-tutor relationship
export const resonanceAnchors = pgTable("resonance_anchors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Who this anchor belongs to
  studentId: varchar("student_id").notNull(),
  
  // What type of resonance this captures
  anchorType: varchar("anchor_type").notNull(), // breakthrough_metaphor, shared_joke, triumph_moment, fear_overcome, personal_connection
  
  // The anchor content
  anchor: text("anchor").notNull(), // "The 'Jazz' metaphor - we used this when overcoming the fear of mistakes"
  triggerContext: text("trigger_context"), // What situation originally created this anchor
  emotionalSignificance: text("emotional_significance"), // Why this matters to the relationship
  
  // When to recall this anchor
  recallTriggers: text("recall_triggers").array(), // ["student_frustrated", "similar_topic", "celebration_moment"]
  lastRecalledAt: timestamp("last_recalled_at"),
  recallCount: integer("recall_count").default(0),
  
  // Impact tracking
  effectivenessRating: real("effectiveness_rating"), // 0.0-1.0 - how well does recalling this help?
  
  // Session origin
  originSessionId: varchar("origin_session_id"),
  originSessionDate: timestamp("origin_session_date"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_resonance_anchors_student").on(table.studentId),
  index("idx_resonance_anchors_type").on(table.anchorType),
  index("idx_resonance_anchors_origin").on(table.originId),
]);

// Relational Temperature - Tracks the emotional phase of each student relationship
// Not proficiency, but the "vibe" - are we in a creative phase? foundation phase?
// Helps Daniela choose which voice or mode to use without being told
export const relationalTemperature = pgTable("relational_temperature", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Who this is tracking
  studentId: varchar("student_id").notNull().unique(),
  
  // Current relationship phase
  relationshipPhase: varchar("relationship_phase").notNull(), // discovery, foundation, growth, jazz, plateau, reconnection
  phaseStartedAt: timestamp("phase_started_at").notNull().defaultNow(),
  
  // Temperature indicators (0.0 to 1.0)
  trustLevel: real("trust_level").default(0.5), // How much do they trust me?
  riskTolerance: real("risk_tolerance").default(0.3), // Can we try hard things together?
  playfulness: real("playfulness").default(0.5), // Are we in a serious or playful mode?
  emotionalOpenness: real("emotional_openness").default(0.3), // Do they share feelings?
  sessionEnthusiasm: real("session_enthusiasm").default(0.5), // Are they excited to learn?
  
  // Recent trends
  lastSessionMood: varchar("last_session_mood"), // energetic, tired, curious, frustrated, celebratory
  moodTrend: varchar("mood_trend"), // improving, stable, declining
  sessionsSincePhaseChange: integer("sessions_since_phase_change").default(0),
  
  // Recommended approach
  suggestedMode: varchar("suggested_mode"), // supportive, challenging, playful, structured, explorative
  suggestedPacing: varchar("suggested_pacing"), // slow, normal, fast
  
  // Notes
  contextNotes: text("context_notes"), // Freeform notes about the relationship
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  
  // Sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_relational_temperature_student").on(table.studentId),
  index("idx_relational_temperature_phase").on(table.relationshipPhase),
  index("idx_relational_temperature_origin").on(table.originId),
]);

// ===== Neural Network Telemetry =====
// Tracks MEMORY_LOOKUP events to monitor Option B (teaching knowledge retrieval) effectiveness
// Enables: prompt size monitoring, domain usage analysis, teaching quality correlation

export const neuralNetworkTelemetry = pgTable("neural_network_telemetry", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Session context
  voiceSessionId: varchar("voice_session_id"),
  userId: varchar("user_id"),
  targetLanguage: varchar("target_language"),
  
  // Query details
  query: text("query").notNull(),
  domainsSearched: varchar("domains_searched").array(),
  domainsRequested: varchar("domains_requested").array(),
  
  // Results metrics
  resultCount: integer("result_count").default(0),
  formattedCharacterLength: integer("formatted_character_length").default(0),
  
  // Domain-specific counts
  idiomCount: integer("idiom_count").default(0),
  culturalCount: integer("cultural_count").default(0),
  procedureCount: integer("procedure_count").default(0),
  principleCount: integer("principle_count").default(0),
  errorPatternCount: integer("error_pattern_count").default(0),
  situationalPatternCount: integer("situational_pattern_count").default(0),
  subtletyCueCount: integer("subtlety_cue_count").default(0),
  emotionalPatternCount: integer("emotional_pattern_count").default(0),
  creativityTemplateCount: integer("creativity_template_count").default(0),
  
  // Quality signals (populated post-hoc if possible)
  knowledgeUsedInResponse: boolean("knowledge_used_in_response"),
  
  // Timing
  searchDurationMs: integer("search_duration_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_neural_telemetry_session").on(table.voiceSessionId),
  index("idx_neural_telemetry_user").on(table.userId),
  index("idx_neural_telemetry_created").on(table.createdAt),
  index("idx_neural_telemetry_language").on(table.targetLanguage),
]);

// ===== Daniela's Proactive Suggestion System =====
// Real-time emergent intelligence where Daniela analyzes patterns and proactively
// suggests improvements to herself, the product, and the HolaHola team

// Suggestion status - lifecycle of a suggestion
export const suggestionStatusEnum = pgEnum('suggestion_status', [
  'emerging',    // Just detected, may need more evidence
  'ready',       // Enough evidence, ready for review
  'reviewed',    // Founder has seen it
  'implemented', // Suggestion was acted upon
  'deferred',    // Valid but not now
  'rejected'     // Not applicable
]);

// Suggestion category - what kind of improvement
export const suggestionCategoryEnum = pgEnum('suggestion_category', [
  'self_improvement',    // Daniela improving her tutoring
  'content_gap',         // Missing drills, topics, cultural content
  'ux_observation',      // UI/UX issues noticed through student behavior
  'teaching_insight',    // Pedagogical pattern that worked/didn't work
  'product_feature',     // Feature idea for HolaHola
  'technical_issue',     // Bug or technical problem observed
  'student_pattern',     // Aggregate pattern across students (privacy-safe)
  'tool_enhancement'     // Improvement to existing whiteboard/drill tools
]);

export const danielaSuggestions = pgTable("daniela_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Classification
  category: suggestionCategoryEnum("category").notNull(),
  status: suggestionStatusEnum("status").default("emerging").notNull(),
  
  // The suggestion itself
  title: varchar("title").notNull(), // Short summary
  description: text("description").notNull(), // Full explanation
  reasoning: text("reasoning"), // Daniela's chain of thought
  
  // Evidence (privacy-safe - no student identifiers)
  evidenceCount: integer("evidence_count").default(0), // How many times pattern observed (starts at 0, increments on each observation)
  evidenceSummary: text("evidence_summary"), // Aggregated observations
  exampleContext: text("example_context"), // Anonymized example
  
  // Priority scoring
  priority: integer("priority").default(50), // 1-100, higher = more important
  confidence: integer("confidence").default(50), // 1-100, how confident Daniela is
  impact: varchar("impact"), // low, medium, high, critical
  
  // Compass context when generated
  compassSnapshot: jsonb("compass_snapshot"), // { sessionPhase, timingContext, studentLevel, etc. }
  triggerContext: jsonb("trigger_context"), // What triggered this insight
  
  // Mode context
  generatedInMode: varchar("generated_in_mode"), // founder_mode, honesty_mode, normal_session
  conversationId: varchar("conversation_id"), // Where it was generated (if applicable)
  
  // For actionable suggestions
  suggestedAction: text("suggested_action"), // What Daniela recommends
  implementationNotes: text("implementation_notes"), // Technical details if applicable
  
  // Tracking
  firstObservedAt: timestamp("first_observed_at").notNull().defaultNow(),
  lastObservedAt: timestamp("last_observed_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: varchar("reviewed_by"), // User ID of reviewer
  reviewNotes: text("review_notes"), // Founder's response
  
  // Linking to other suggestions (for clustering similar insights)
  relatedSuggestionIds: varchar("related_suggestion_ids").array(),
  
  // Language/content context
  targetLanguage: varchar("target_language"), // If language-specific
  affectedTools: varchar("affected_tools").array(), // WRITE, PHONETIC, etc.
  affectedFeatures: varchar("affected_features").array(), // drills, voice_chat, etc.
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  // Tri-Lane Hive collaboration metadata
  originRole: varchar("origin_role").default("tutor"), // tutor, partner (Daniela's two roles)
  domainTags: text("domain_tags").array(), // pedagogy, architecture, tooling, student_experience
  intentHash: varchar("intent_hash"), // For cross-agent deduplication
  acknowledgedByEditor: boolean("acknowledged_by_editor").default(false), // Editor reviewed if architecture-affecting
  acknowledgedAt: timestamp("acknowledged_at"),
}, (table) => [
  index("idx_daniela_suggestions_category").on(table.category),
  index("idx_daniela_suggestions_status").on(table.status),
  index("idx_daniela_suggestions_priority").on(table.priority),
  index("idx_daniela_suggestions_mode").on(table.generatedInMode),
  index("idx_daniela_suggestions_origin").on(table.originId),
  index("idx_daniela_suggestions_intent").on(table.intentHash),
]);

// ===== Daniela's Reflection Triggers =====
// Patterns that activate her proactive analysis during conversations

export const reflectionTriggers = pgTable("reflection_triggers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Trigger identification
  triggerName: varchar("trigger_name").notNull(),
  triggerType: varchar("trigger_type").notNull(), // compass_based, pattern_based, mode_based, threshold_based
  
  // When to activate
  compassConditions: jsonb("compass_conditions"), // { elapsedMinutes: '>5', sessionPhase: 'core' }
  patternConditions: jsonb("pattern_conditions"), // { errorCount: '>3', toolUsage: 'none' }
  modeConditions: jsonb("mode_conditions"), // { mode: ['founder_mode', 'honesty_mode'] }
  
  // What to analyze
  analysisPrompt: text("analysis_prompt").notNull(), // What should Daniela think about?
  suggestionCategories: varchar("suggestion_categories").array(), // Which categories might result
  
  // Output guidance
  evidenceRequired: integer("evidence_required").default(1), // Min observations before suggesting
  cooldownMinutes: integer("cooldown_minutes").default(10), // Don't re-trigger for X minutes
  
  priority: integer("priority").default(50),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_reflection_triggers_type").on(table.triggerType),
  index("idx_reflection_triggers_origin").on(table.originId),
]);

// Daniela's Suggestion Actions - tracks team responses to suggestions
export const danielaSuggestionActions = pgTable("daniela_suggestion_actions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  suggestionId: varchar("suggestion_id").notNull().references(() => danielaSuggestions.id),
  
  // Action taken
  actionType: varchar("action_type").notNull(), // starred, implemented, dismissed, archived, commented
  actionBy: varchar("action_by"), // User ID who took action
  comment: text("comment"), // Optional comment explaining the action
  
  // Implementation details
  implementedIn: varchar("implemented_in"), // PR number, deployment version, etc.
  implementationNotes: text("implementation_notes"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
}, (table) => [
  index("idx_suggestion_actions_suggestion").on(table.suggestionId),
  index("idx_suggestion_actions_type").on(table.actionType),
  index("idx_suggestion_actions_origin").on(table.originId),
]);

// ===== Daniela's Self-Surgery Proposals =====
// Direct neural network modifications proposed by Daniela during Founder Mode sessions
// These are structured data ready to be promoted to target tables with one-click approval

export const selfSurgeryStatusEnum = pgEnum('self_surgery_status', [
  'pending',     // Awaiting review
  'approved',    // Reviewed and approved, ready to promote
  'promoted',    // Successfully inserted into target table
  'rejected',    // Not applicable or incorrect
  'edited'       // Modified by founder before promotion
]);

export const selfSurgeryTargetEnum = pgEnum('self_surgery_target', [
  'tutor_procedures',
  'teaching_principles', 
  'tool_knowledge',
  'situational_patterns',
  'language_idioms',
  'cultural_nuances',
  'learner_error_patterns',
  'dialect_variations',
  'linguistic_bridges',
  'creativity_templates'
]);

export const selfSurgeryProposals = pgTable("self_surgery_proposals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Target table and proposed content
  targetTable: selfSurgeryTargetEnum("target_table").notNull(),
  proposedContent: jsonb("proposed_content").notNull(), // Structured data matching target table schema
  
  // Daniela's reasoning
  reasoning: text("reasoning").notNull(), // Why she's proposing this
  triggerContext: text("trigger_context"), // What happened in session that prompted this
  
  // Status tracking
  status: selfSurgeryStatusEnum("status").default("pending").notNull(),
  
  // Session context
  conversationId: varchar("conversation_id"),
  sessionMode: varchar("session_mode"), // founder_mode, honesty_mode, normal
  targetLanguage: varchar("target_language"),
  
  // Review tracking
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: varchar("reviewed_by"), // User ID
  reviewNotes: text("review_notes"),
  editedContent: jsonb("edited_content"), // If founder modified before promotion
  
  // Promotion tracking
  promotedAt: timestamp("promoted_at"),
  promotedRecordId: varchar("promoted_record_id"), // ID of the record created in target table
  
  // Priority and confidence
  priority: integer("priority").default(50), // 1-100
  confidence: integer("confidence").default(70), // How confident Daniela is
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_self_surgery_status").on(table.status),
  index("idx_self_surgery_target").on(table.targetTable),
  index("idx_self_surgery_conversation").on(table.conversationId),
]);

// Insert schema and types for Self-Surgery Proposals
export const insertSelfSurgeryProposalSchema = createInsertSchema(selfSurgeryProposals).omit({
  id: true,
  createdAt: true,
  reviewedAt: true,
  promotedAt: true,
});

export type InsertSelfSurgeryProposal = z.infer<typeof insertSelfSurgeryProposalSchema>;
export type SelfSurgeryProposal = typeof selfSurgeryProposals.$inferSelect;

// Insert schemas for Procedural Memory
export const insertTutorProcedureSchema = createInsertSchema(tutorProcedures).omit({
  id: true,
  createdAt: true,
});

export const insertToolKnowledgeSchema = createInsertSchema(toolKnowledge).omit({
  id: true,
  createdAt: true,
});

export const insertSituationalPatternSchema = createInsertSchema(situationalPatterns).omit({
  id: true,
  createdAt: true,
});

export const insertTeachingPrincipleSchema = createInsertSchema(teachingPrinciples).omit({
  id: true,
  createdAt: true,
});

// Types for Procedural Memory
export type InsertTutorProcedure = z.infer<typeof insertTutorProcedureSchema>;
export type TutorProcedure = typeof tutorProcedures.$inferSelect;

export type InsertToolKnowledge = z.infer<typeof insertToolKnowledgeSchema>;
export type ToolKnowledge = typeof toolKnowledge.$inferSelect;

export type InsertSituationalPattern = z.infer<typeof insertSituationalPatternSchema>;
export type SituationalPattern = typeof situationalPatterns.$inferSelect;

export type InsertTeachingPrinciple = z.infer<typeof insertTeachingPrincipleSchema>;
export type TeachingPrinciple = typeof teachingPrinciples.$inferSelect;

// Insert schemas for Neural Network Expansion
export const insertLanguageIdiomSchema = createInsertSchema(languageIdioms).omit({
  id: true,
  createdAt: true,
});

export const insertCulturalNuanceSchema = createInsertSchema(culturalNuances).omit({
  id: true,
  createdAt: true,
});

export const insertLearnerErrorPatternSchema = createInsertSchema(learnerErrorPatterns).omit({
  id: true,
  createdAt: true,
});

export const insertDialectVariationSchema = createInsertSchema(dialectVariations).omit({
  id: true,
  createdAt: true,
});

export const insertLinguisticBridgeSchema = createInsertSchema(linguisticBridges).omit({
  id: true,
  createdAt: true,
});

// Types for Neural Network Expansion
export type InsertLanguageIdiom = z.infer<typeof insertLanguageIdiomSchema>;
export type LanguageIdiom = typeof languageIdioms.$inferSelect;

export type InsertCulturalNuance = z.infer<typeof insertCulturalNuanceSchema>;
export type CulturalNuance = typeof culturalNuances.$inferSelect;

export type InsertLearnerErrorPattern = z.infer<typeof insertLearnerErrorPatternSchema>;
export type LearnerErrorPattern = typeof learnerErrorPatterns.$inferSelect;

export type InsertDialectVariation = z.infer<typeof insertDialectVariationSchema>;
export type DialectVariation = typeof dialectVariations.$inferSelect;

export type InsertLinguisticBridge = z.infer<typeof insertLinguisticBridgeSchema>;
export type LinguisticBridge = typeof linguisticBridges.$inferSelect;

// Insert schemas for Advanced Intelligence Layer
export const insertSubtletyCueSchema = createInsertSchema(subtletyCues).omit({
  id: true,
  createdAt: true,
});

export const insertEmotionalPatternSchema = createInsertSchema(emotionalPatterns).omit({
  id: true,
  createdAt: true,
});

export const insertCreativityTemplateSchema = createInsertSchema(creativityTemplates).omit({
  id: true,
  createdAt: true,
});

// Types for Advanced Intelligence Layer
export type InsertSubtletyCue = z.infer<typeof insertSubtletyCueSchema>;
export type SubtletyCue = typeof subtletyCues.$inferSelect;

export type InsertEmotionalPattern = z.infer<typeof insertEmotionalPatternSchema>;
export type EmotionalPattern = typeof emotionalPatterns.$inferSelect;

export type InsertCreativityTemplate = z.infer<typeof insertCreativityTemplateSchema>;
export type CreativityTemplate = typeof creativityTemplates.$inferSelect;

// Insert schemas for Daniela's Wisdom & Relationship Layer
export const insertDerivedTeachingWisdomSchema = createInsertSchema(derivedTeachingWisdom).omit({
  id: true,
  createdAt: true,
});

export const insertResonanceAnchorSchema = createInsertSchema(resonanceAnchors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRelationalTemperatureSchema = createInsertSchema(relationalTemperature).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types for Daniela's Wisdom & Relationship Layer
export type InsertDerivedTeachingWisdom = z.infer<typeof insertDerivedTeachingWisdomSchema>;
export type DerivedTeachingWisdom = typeof derivedTeachingWisdom.$inferSelect;

export type InsertResonanceAnchor = z.infer<typeof insertResonanceAnchorSchema>;
export type ResonanceAnchor = typeof resonanceAnchors.$inferSelect;

export type InsertRelationalTemperature = z.infer<typeof insertRelationalTemperatureSchema>;
export type RelationalTemperature = typeof relationalTemperature.$inferSelect;

// Insert schema for Neural Network Telemetry
export const insertNeuralNetworkTelemetrySchema = createInsertSchema(neuralNetworkTelemetry).omit({
  id: true,
  createdAt: true,
});

export type InsertNeuralNetworkTelemetry = z.infer<typeof insertNeuralNetworkTelemetrySchema>;
export type NeuralNetworkTelemetry = typeof neuralNetworkTelemetry.$inferSelect;

// Insert schemas for Daniela's Proactive Suggestion System
export const insertDanielaSuggestionSchema = createInsertSchema(danielaSuggestions).omit({
  id: true,
  createdAt: true,
  firstObservedAt: true,
  lastObservedAt: true,
});

export const insertReflectionTriggerSchema = createInsertSchema(reflectionTriggers).omit({
  id: true,
  createdAt: true,
});

// Types for Daniela's Proactive Suggestion System
export type InsertDanielaSuggestion = z.infer<typeof insertDanielaSuggestionSchema>;
export type DanielaSuggestion = typeof danielaSuggestions.$inferSelect;

export type InsertReflectionTrigger = z.infer<typeof insertReflectionTriggerSchema>;
export type ReflectionTrigger = typeof reflectionTriggers.$inferSelect;

export const insertDanielaSuggestionActionSchema = createInsertSchema(danielaSuggestionActions).omit({
  id: true,
  createdAt: true,
});

export type InsertDanielaSuggestionAction = z.infer<typeof insertDanielaSuggestionActionSchema>;
export type DanielaSuggestionAction = typeof danielaSuggestionActions.$inferSelect;

// ===== ACTFL Assessment Events =====
// Logs Daniela's ACTFL proficiency assessments with tool context for effectiveness tracking
// Enables: "Students who received COMPARE tool showed 40% faster mastery"

export const actflAssessmentEvents = pgTable("actfl_assessment_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Who was assessed
  userId: varchar("user_id").references(() => users.id),
  language: varchar("language").notNull(),
  
  // The assessment
  previousLevel: varchar("previous_level"),
  newLevel: varchar("new_level").notNull(),
  direction: varchar("direction"), // up, down, confirm
  confidence: integer("confidence"), // 0-100 based on Daniela's 0.0-1.0
  reason: text("reason").notNull(), // Daniela's reasoning
  
  // Tool context (what tools were used in preceding messages)
  toolsUsedBefore: text("tools_used_before").array(), // Last 5 messages worth
  toolsUsedSession: text("tools_used_session").array(), // Entire session
  messageCountBefore: integer("message_count_before"), // How many messages in session
  
  // Session context
  voiceSessionId: varchar("voice_session_id").references(() => voiceSessions.id),
  conversationId: varchar("conversation_id").references(() => conversations.id),
  classId: varchar("class_id"),
  
  // Analytics
  sessionDurationSeconds: integer("session_duration_seconds"),
  correctionCountSession: integer("correction_count_session"), // Track errors before assessment
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_actfl_events_user").on(table.userId),
  index("idx_actfl_events_language").on(table.language),
  index("idx_actfl_events_level").on(table.newLevel),
  index("idx_actfl_events_created").on(table.createdAt),
]);

export const insertActflAssessmentEventSchema = createInsertSchema(actflAssessmentEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertActflAssessmentEvent = z.infer<typeof insertActflAssessmentEventSchema>;
export type ActflAssessmentEvent = typeof actflAssessmentEvents.$inferSelect;

// ===== Agent Observations (Development Agent's Neural Network) =====
// Persistent observations from the development agent about system improvements
// Enables: Agent learns across sessions, proposes improvements that sync

export const agentObservationCategoryEnum = pgEnum('agent_observation_category', [
  'architecture',      // System design observations
  'pattern',           // Recurring patterns noticed
  'improvement',       // Proposed improvements
  'bug_pattern',       // Error patterns observed
  'user_behavior',     // Aggregated user behavior insights
  'performance',       // Performance observations
  'daniela_behavior',  // Observations about Daniela's teaching
  'sync_issue',        // Issues with neural network sync
  'next_step'          // Identified next development steps
]);

export const agentObservations = pgTable("agent_observations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Classification
  category: agentObservationCategoryEnum("category").notNull(),
  priority: integer("priority").default(50), // 1-100
  
  // The observation
  title: varchar("title").notNull(),
  observation: text("observation").notNull(),
  reasoning: text("reasoning"), // Chain of thought
  
  // Evidence
  evidenceCount: integer("evidence_count").default(1),
  evidenceSummary: text("evidence_summary"),
  relatedFiles: text("related_files").array(), // File paths involved
  
  // Proposed action
  proposedAction: text("proposed_action"),
  proposedCode: text("proposed_code"), // If suggesting code changes
  targetTable: varchar("target_table"), // If proposing neural network entry
  
  // Status
  status: varchar("status").default("active"), // active, implemented, deferred, rejected
  implementedAt: timestamp("implemented_at"),
  implementedBy: varchar("implemented_by"),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  // Tri-Lane Hive collaboration metadata
  originRole: varchar("origin_role").default("editor"), // editor (development agent)
  domainTags: text("domain_tags").array(), // architecture, performance, pedagogy, operations
  intentHash: varchar("intent_hash"), // For cross-agent deduplication
  acknowledgedByDaniela: boolean("acknowledged_by_daniela").default(false), // Daniela reviewed if pedagogy-affecting
  acknowledgedBySupport: boolean("acknowledged_by_support").default(false), // Support reviewed if operations-affecting
  acknowledgedAt: timestamp("acknowledged_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_agent_observations_category").on(table.category),
  index("idx_agent_observations_status").on(table.status),
  index("idx_agent_observations_priority").on(table.priority),
  index("idx_agent_observations_origin").on(table.originId),
  index("idx_agent_observations_intent").on(table.intentHash),
]);

export const insertAgentObservationSchema = createInsertSchema(agentObservations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAgentObservation = z.infer<typeof insertAgentObservationSchema>;
export type AgentObservation = typeof agentObservations.$inferSelect;

// ===== Support Agent Observations (Operations Agent's Neural Network) =====
// Persistent observations from the support agent about user experience, issues, and operations
// Enables: Support learns from user interactions, proposes help resources, proactive alerts

export const supportObservationCategoryEnum = pgEnum('support_observation_category', [
  'user_friction',       // Points where users struggle
  'common_question',     // Frequently asked questions
  'system_issue',        // Platform problems observed
  'feature_request',     // User-requested features (aggregated)
  'success_pattern',     // What helps users succeed
  'documentation_gap',   // Missing help content
  'onboarding_insight',  // New user experience observations
  'billing_pattern',     // Common billing/subscription issues
  'troubleshoot_solution' // Successful troubleshooting patterns
]);

export const supportObservations = pgTable("support_observations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Classification
  category: supportObservationCategoryEnum("category").notNull(),
  priority: integer("priority").default(50), // 1-100
  
  // The observation
  title: varchar("title").notNull(),
  observation: text("observation").notNull(),
  reasoning: text("reasoning"), // Support's analysis
  
  // Evidence
  evidenceCount: integer("evidence_count").default(1), // How many times observed
  evidenceSummary: text("evidence_summary"),
  affectedUserCount: integer("affected_user_count"), // Anonymized impact count
  
  // Proposed action
  proposedSolution: text("proposed_solution"), // Suggested fix or help content
  proposedFaqEntry: text("proposed_faq_entry"), // If should become FAQ
  escalationNeeded: boolean("escalation_needed").default(false), // Needs founder/dev attention
  
  // Status
  status: varchar("status").default("active"), // active, resolved, escalated, archived
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by"),
  resolutionNotes: text("resolution_notes"),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  // Tri-Lane Hive collaboration metadata
  originRole: varchar("origin_role").default("support"), // support (operations agent)
  domainTags: text("domain_tags").array(), // operations, user_experience, billing, technical
  intentHash: varchar("intent_hash"), // For cross-agent deduplication
  acknowledgedByEditor: boolean("acknowledged_by_editor").default(false), // Editor reviewed if technical
  acknowledgedByDaniela: boolean("acknowledged_by_daniela").default(false), // Daniela reviewed if pedagogy
  acknowledgedAt: timestamp("acknowledged_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_support_observations_category").on(table.category),
  index("idx_support_observations_status").on(table.status),
  index("idx_support_observations_priority").on(table.priority),
  index("idx_support_observations_escalation").on(table.escalationNeeded),
  index("idx_support_observations_origin").on(table.originId),
  index("idx_support_observations_intent").on(table.intentHash),
]);

export const insertSupportObservationSchema = createInsertSchema(supportObservations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSupportObservation = z.infer<typeof insertSupportObservationSchema>;
export type SupportObservation = typeof supportObservations.$inferSelect;

// ===== System Alerts (Proactive Support Communications) =====
// Support agent's proactive announcements about system status, issues, and updates
// Enables: Support can warn users before they hit problems, announce maintenance, etc.

export const systemAlertSeverityEnum = pgEnum('system_alert_severity', [
  'info',      // General announcements, tips
  'notice',    // New features, minor changes
  'warning',   // Degraded performance, known issues
  'outage',    // Service disruption
  'resolved'   // Issue resolved notification
]);

export const systemAlertTargetEnum = pgEnum('system_alert_target', [
  'all',           // All users
  'voice_users',   // Users in voice chat
  'teachers',      // Teacher accounts
  'students',      // Student accounts
  'new_users',     // Recently joined (onboarding)
  'premium'        // Paid subscribers
]);

export const systemAlerts = pgTable("system_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Alert content
  severity: systemAlertSeverityEnum("severity").notNull(),
  title: varchar("title").notNull(),
  message: text("message").notNull(),
  
  // Targeting
  target: systemAlertTargetEnum("target").default("all"),
  affectedFeatures: text("affected_features").array(), // voice_chat, drills, etc.
  
  // Display behavior
  isDismissible: boolean("is_dismissible").default(true), // User can close
  showInChat: boolean("show_in_chat").default(true), // Appears in chat area
  showAsBanner: boolean("show_as_banner").default(false), // Top of page banner
  
  // Timing
  startsAt: timestamp("starts_at").notNull().defaultNow(), // When to start showing
  expiresAt: timestamp("expires_at"), // When to stop (null = manual)
  
  // Status
  isActive: boolean("is_active").default(true),
  createdBy: varchar("created_by"), // support_agent, system_auto, manual
  
  // Tracking
  viewCount: integer("view_count").default(0),
  dismissCount: integer("dismiss_count").default(0),
  
  // Related issue tracking
  relatedIncidentId: varchar("related_incident_id"), // If tracking an incident
  resolvedByAlertId: varchar("resolved_by_alert_id"), // Links warning → resolution
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_system_alerts_severity").on(table.severity),
  index("idx_system_alerts_active").on(table.isActive),
  index("idx_system_alerts_target").on(table.target),
  index("idx_system_alerts_starts").on(table.startsAt),
  index("idx_system_alerts_origin").on(table.originId),
]);

export const insertSystemAlertSchema = createInsertSchema(systemAlerts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  viewCount: true,
  dismissCount: true,
});

export type InsertSystemAlert = z.infer<typeof insertSystemAlertSchema>;
export type SystemAlert = typeof systemAlerts.$inferSelect;

// ============================================================================
// SYNTHESIZED INSIGHTS - Condensed observations for efficient sync
// ============================================================================
// v23: Wren synthesizes 100+ observations into 1 insight for cross-environment sync
// This reduces sync payload from 388K observations to ~4K insights

export const synthesizedInsightCategoryEnum = pgEnum('synthesized_insight_category', [
  'teaching_pattern',    // Patterns in Daniela's teaching effectiveness
  'error_cluster',       // Clustered error patterns from students
  'feature_usage',       // How features are being used/adopted
  'system_health',       // Platform performance patterns
  'student_journey',     // Common learning paths
  'content_quality',     // Quality patterns in curriculum
  'voice_quality',       // Voice pipeline patterns
  'support_trend',       // Support request patterns
  'cross_agent'          // Patterns involving multiple agents
]);

export const synthesizedInsights = pgTable("synthesized_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Classification
  category: synthesizedInsightCategoryEnum("category").notNull(),
  priority: integer("priority").default(50), // 1-100
  
  // The synthesized insight
  title: varchar("title").notNull(),
  insight: text("insight").notNull(), // The condensed learning
  supportingEvidence: text("supporting_evidence"), // Summarized evidence
  actionableRecommendation: text("actionable_recommendation"),
  
  // Aggregation metadata
  observationCount: integer("observation_count").default(0), // How many observations synthesized
  observationIds: text("observation_ids").array(), // IDs of source observations
  timeRangeStart: timestamp("time_range_start"), // Oldest observation
  timeRangeEnd: timestamp("time_range_end"), // Newest observation
  sourceCategories: text("source_categories").array(), // Which observation categories included
  
  // Confidence & validation
  confidence: integer("confidence").default(70), // 0-100 confidence in synthesis
  validatedByFounder: boolean("validated_by_founder").default(false),
  validatedAt: timestamp("validated_at"),
  
  // Impact tracking
  impactScore: integer("impact_score").default(0), // How impactful this insight is
  affectedUsers: integer("affected_users").default(0), // Estimated users affected
  affectedSessions: integer("affected_sessions").default(0),
  
  // Two-way sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_synthesized_insights_category").on(table.category),
  index("idx_synthesized_insights_priority").on(table.priority),
  index("idx_synthesized_insights_created").on(table.createdAt),
  index("idx_synthesized_insights_origin").on(table.originId),
]);

export const insertSynthesizedInsightSchema = createInsertSchema(synthesizedInsights).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSynthesizedInsight = z.infer<typeof insertSynthesizedInsightSchema>;
export type SynthesizedInsight = typeof synthesizedInsights.$inferSelect;

// ============================================================================
// SUPPORT TICKETS - Daniela-to-Support handoff tracking
// ============================================================================

export const supportTicketStatusEnum = pgEnum("support_ticket_status", [
  "pending",      // Just created, waiting for Support pickup
  "active",       // Support Agent actively engaged
  "resolved",     // Issue resolved
  "escalated",    // Escalated to human support
  "cancelled",    // Cancelled by user or timeout
]);

export const supportTicketPriorityEnum = pgEnum("support_ticket_priority", [
  "low",          // General questions
  "normal",       // Standard support request
  "high",         // Urgent issue affecting learning
  "critical",     // Blocking issue (payment, access)
]);

export const supportTicketCategoryEnum = pgEnum("support_ticket_category", [
  "technical",    // App not working, bugs
  "account",      // Login, subscription, settings
  "billing",      // Payment, refunds, upgrades
  "content",      // Course content, curriculum issues
  "feedback",     // Suggestions, complaints
  "other",        // Miscellaneous
]);

export const supportTickets = pgTable("support_tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // User context
  userId: varchar("user_id").notNull(),
  conversationId: varchar("conversation_id"), // Original tutoring conversation
  
  // Ticket content
  category: supportTicketCategoryEnum("category").notNull(),
  priority: supportTicketPriorityEnum("priority").default("normal"),
  status: supportTicketStatusEnum("status").default("pending"),
  
  // Issue details
  subject: varchar("subject").notNull(),
  description: text("description").notNull(),
  
  // Handoff context from Daniela
  handoffReason: text("handoff_reason"), // Why Daniela referred to support
  tutorContext: text("tutor_context"), // Recent conversation context
  targetLanguage: varchar("target_language"), // Language being learned
  
  // Support session
  supportSessionId: varchar("support_session_id"), // Active support chat session
  assignedTo: varchar("assigned_to"), // Support agent or "ai_support"
  
  // Resolution
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at"),
  
  // User satisfaction
  satisfactionRating: integer("satisfaction_rating"), // 1-5 stars
  satisfactionFeedback: text("satisfaction_feedback"),
  
  // Tracking
  firstResponseAt: timestamp("first_response_at"),
  messageCount: integer("message_count").default(0),
  
  // Two-way sync fields (for analytics)
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_support_tickets_user").on(table.userId),
  index("idx_support_tickets_status").on(table.status),
  index("idx_support_tickets_priority").on(table.priority),
  index("idx_support_tickets_category").on(table.category),
  index("idx_support_tickets_created").on(table.createdAt),
]);

export const insertSupportTicketSchema = createInsertSchema(supportTickets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  messageCount: true,
});

export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type SupportTicket = typeof supportTickets.$inferSelect;

// Support ticket messages (separate from tutoring messages)
export const supportMessages = pgTable("support_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ticketId: varchar("ticket_id").notNull(),
  
  // Message content
  role: varchar("role").notNull(), // "user", "support_agent", "system"
  content: text("content").notNull(),
  
  // For voice support
  audioUrl: varchar("audio_url"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_support_messages_ticket").on(table.ticketId),
]);

export const insertSupportMessageSchema = createInsertSchema(supportMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertSupportMessage = z.infer<typeof insertSupportMessageSchema>;
export type SupportMessage = typeof supportMessages.$inferSelect;

// Support knowledge base - troubleshooting scripts and FAQ answers for Sofia
export const supportKnowledgeBase = pgTable("support_knowledge_base", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Categorization
  category: varchar("category").notNull(), // 'audio', 'browser', 'how-to', 'account', 'billing'
  title: varchar("title").notNull(),
  keywords: text("keywords").array(), // For search matching
  
  // Problem and solution
  problem: text("problem").notNull(), // What the user might say/ask
  solution: text("solution").notNull(), // Sofia's response template
  steps: jsonb("steps"), // Step-by-step resolution instructions
  
  // Browser/device specific variations
  browserSpecific: jsonb("browser_specific"), // { chrome: "...", safari: "...", firefox: "..." }
  deviceSpecific: jsonb("device_specific"), // { mobile: "...", desktop: "..." }
  
  // Effectiveness tracking
  isActive: boolean("is_active").default(true),
  useCount: integer("use_count").default(0),
  successCount: integer("success_count").default(0),
  
  // Sync fields
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_support_kb_category").on(table.category),
  index("idx_support_kb_active").on(table.isActive),
]);

export const insertSupportKnowledgeBaseSchema = createInsertSchema(supportKnowledgeBase).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  useCount: true,
  successCount: true,
});

export type InsertSupportKnowledgeBase = z.infer<typeof insertSupportKnowledgeBaseSchema>;
export type SupportKnowledgeBase = typeof supportKnowledgeBase.$inferSelect;

// Support issue patterns - aggregated patterns for founder visibility
export const supportPatterns = pgTable("support_patterns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Pattern details
  patternType: varchar("pattern_type").notNull(), // 'browser_bug', 'feature_request', 'ux_confusion'
  description: text("description").notNull(),
  
  // Affected systems
  affectedBrowsers: text("affected_browsers").array(),
  affectedDevices: text("affected_devices").array(),
  
  // Tracking
  occurrenceCount: integer("occurrence_count").default(1),
  firstSeen: timestamp("first_seen").notNull().defaultNow(),
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
  
  // Status and notes
  status: varchar("status").default("open"), // 'open', 'investigating', 'fixed', 'wont_fix'
  developerNotes: text("developer_notes"),
  
  // Deduplication — prevents Sofia from re-escalating the same benign pattern repeatedly.
  // Hash is deterministic: sha256(issueType:environment). Any pattern with a matching
  // signatureHash that has already been investigated is updated (count++) not re-inserted.
  signatureHash: varchar("signature_hash", { length: 64 }),

  // Sync fields (patterns sync prod→dev for founder visibility)
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_support_patterns_type").on(table.patternType),
  index("idx_support_patterns_status").on(table.status),
  index("idx_support_patterns_signature").on(table.signatureHash),
]);

export const insertSupportPatternSchema = createInsertSchema(supportPatterns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  occurrenceCount: true,
  firstSeen: true,
  lastSeen: true,
});

export type InsertSupportPattern = z.infer<typeof insertSupportPatternSchema>;
export type SupportPattern = typeof supportPatterns.$inferSelect;

// Sofia Issue Reports - diagnostic snapshots when Sofia detects customer issues
// These are created automatically when Sofia hears about voice/audio problems
export const sofiaIssueReports = pgTable("sofia_issue_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // User context
  userId: varchar("user_id").notNull(),
  ticketId: varchar("ticket_id"), // Link to support ticket if exists
  
  // Issue details
  issueType: varchar("issue_type").notNull(), // 'double_audio', 'no_audio', 'latency', 'connection', 'other'
  userDescription: text("user_description").notNull(), // What the user said
  sofiaAnalysis: text("sofia_analysis"), // Sofia's assessment
  
  // Diagnostic snapshot at time of report
  diagnosticSnapshot: jsonb("diagnostic_snapshot"), // VoiceDiagnostics data
  clientTelemetry: jsonb("client_telemetry"), // Queue depth, audio events, etc.
  
  // Device/browser context
  deviceInfo: jsonb("device_info"), // browser, os, device
  
  // Founder review
  status: varchar("status").default("pending"), // 'pending', 'reviewed', 'actionable', 'resolved', 'duplicate'
  founderNotes: text("founder_notes"),
  reviewedAt: timestamp("reviewed_at"),
  
  // Tracking
  environment: varchar("environment").default("development"), // 'development' or 'production'
  
  // Two-way sync (prod→dev for founder visibility)
  syncStatus: varchar("sync_status").default("local"),
  originId: varchar("origin_id"),
  originEnvironment: varchar("origin_environment"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sofia_reports_user").on(table.userId),
  index("idx_sofia_reports_type").on(table.issueType),
  index("idx_sofia_reports_status").on(table.status),
  index("idx_sofia_reports_created").on(table.createdAt),
]);

export const insertSofiaIssueReportSchema = createInsertSchema(sofiaIssueReports).omit({
  id: true,
  createdAt: true,
});

export type InsertSofiaIssueReport = z.infer<typeof insertSofiaIssueReportSchema>;
export type SofiaIssueReport = typeof sofiaIssueReports.$inferSelect;

// ===== AGENT COLLABORATION =====
// Cross-agent text-based communication for the Hive Mind

export const agentCollaborationEventTypeEnum = pgEnum("agent_collaboration_event_type", [
  "question",        // Asking another agent for input
  "response",        // Answering a question
  "feedback",        // Sharing observations about a student/session
  "delegation",      // Assigning work to another agent
  "delegation_complete", // Work completed notification
  "status_update",   // General status info
  "consultation",    // Requesting collaborative problem-solving
  "acknowledgment",  // Confirming receipt/understanding
]);

export const agentRoleEnum = pgEnum("agent_role", [
  "daniela",    // Lead tutor (Gemini)
  "assistant",  // Assistant tutor for drills (future)
  "support",    // Support/operations agent
  "editor",     // Development agent (Claude)
]);

export const securityClassificationEnum = pgEnum("security_classification", [
  "public",           // Safe for Gemini - student-facing teaching tips, feature ideas
  "internal",         // NEVER goes to Gemini - architecture, security, code details
  "daniela_summary",  // Daniela sees summary only, not full content
]);

export const agentCollaborationEvents = pgTable("agent_collaboration_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Who sent and receives
  fromAgent: agentRoleEnum("from_agent").notNull(),
  toAgent: agentRoleEnum("to_agent"), // null = broadcast to all agents
  
  // Event classification
  eventType: agentCollaborationEventTypeEnum("event_type").notNull(),
  
  // SECURITY CLASSIFICATION - Protects code/architecture from Gemini
  // "public" = safe for Gemini context
  // "internal" = NEVER goes to Gemini (code, security, architecture)
  // "daniela_summary" = Daniela sees summary only, not full content
  securityClassification: securityClassificationEnum("security_classification").notNull().default("public"),
  
  // The actual message
  subject: varchar("subject", { length: 255 }),
  content: text("content").notNull(),
  
  // For "daniela_summary" classification: what Daniela sees instead of full content
  publicSummary: text("public_summary"),
  
  // Optional structured payload
  metadata: jsonb("metadata").$type<{
    delegationId?: string;
    studentContext?: Record<string, unknown>;
    threadId?: string;
    priority?: "low" | "medium" | "high";
    tags?: string[];
  }>(),
  
  // Context linking
  userId: varchar("user_id"),
  conversationId: varchar("conversation_id"),
  relatedEventId: varchar("related_event_id"), // For threading responses
  
  // Status tracking
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  acknowledgedBy: agentRoleEnum("acknowledged_by"),
  acknowledgedAt: timestamp("acknowledged_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_collab_events_from").on(table.fromAgent),
  index("idx_collab_events_to").on(table.toAgent),
  index("idx_collab_events_type").on(table.eventType),
  index("idx_collab_events_status").on(table.status),
  index("idx_collab_events_user").on(table.userId),
  index("idx_collab_events_created").on(table.createdAt),
  index("idx_collab_events_security").on(table.securityClassification),
]);

// Helper type for security-filtered messages going to Daniela's context
export type SecureAgentMessage = {
  id: string;
  fromAgent: string;
  subject: string | null;
  content: string;       // For "daniela_summary", this is the publicSummary, not the real content
  eventType: string;
  createdAt: Date;
};

export const insertAgentCollaborationEventSchema = createInsertSchema(agentCollaborationEvents).omit({
  id: true,
  createdAt: true,
  acknowledgedAt: true,
});

export type InsertAgentCollaborationEvent = z.infer<typeof insertAgentCollaborationEventSchema>;
export type AgentCollaborationEvent = typeof agentCollaborationEvents.$inferSelect;

// ===== ARIS (ASSISTANT TUTOR) =====
// Drill assignments and results for Daniela's assistant

export const arisDrillAssignmentStatusEnum = pgEnum("aris_drill_assignment_status", [
  "pending",      // Assigned but not started
  "in_progress",  // Student currently working on it
  "completed",    // Finished, results posted
  "expired",      // Not completed within time limit
  "cancelled",    // Cancelled by Daniela or system
]);

export const arisDrillTypeEnum = pgEnum("aris_drill_type", [
  "repeat",        // Pronunciation practice
  "translate",     // Native to target language
  "match",         // Vocabulary matching
  "fill_blank",    // Grammar fill-in-the-blank
  "sentence_order", // Word ordering
]);

// Drill origin - where this drill came from
export const arisDrillOriginEnum = pgEnum("aris_drill_origin", [
  "syllabus_bundle",  // Auto-provisioned from lesson bundle
  "daniela_manual",   // Daniela created on-the-fly during conversation
]);

// Drill lifecycle state - tracks progression through the drill workflow
export const arisDrillLifecycleEnum = pgEnum("aris_drill_lifecycle", [
  "planned",    // Auto-created from lesson bundle, not yet started
  "active",     // Student currently working on this drill
  "completed",  // Drill finished successfully
  "delegated",  // Handed off to assistant tutor
  "skipped",    // Student or tutor decided to skip
]);

// Who handles the drill execution
export const arisDrillHandlerEnum = pgEnum("aris_drill_handler", [
  "daniela",    // Main tutor handles directly in conversation
  "assistant",  // Delegated to assistant tutor (practice page)
  "both",       // Started with Daniela, delegated to assistant for practice
]);

// Assignments from Daniela to Aris
export const arisDrillAssignments = pgTable("aris_drill_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Who is this for
  userId: varchar("user_id").notNull(),
  conversationId: varchar("conversation_id"), // Link to original tutoring session
  
  // Delegation context
  delegatedBy: agentRoleEnum("delegated_by").notNull().default("daniela"),
  delegationEventId: varchar("delegation_event_id"), // Link to collaboration event
  
  // Drill specification
  drillType: arisDrillTypeEnum("drill_type").notNull(),
  targetLanguage: varchar("target_language", { length: 50 }).notNull(),
  
  // Content for the drill
  drillContent: jsonb("drill_content").$type<{
    items: Array<{
      prompt: string;           // What to show/say
      expectedAnswer?: string;  // For translate/fill_blank
      options?: string[];       // For match/fill_blank dropdowns
      pronunciation?: string;   // Phonetic guide
    }>;
    instructions?: string;
    focusArea?: string;        // e.g., "rolling R sounds", "ser vs estar"
    difficulty?: "easy" | "medium" | "hard";
  }>().notNull(),
  
  // Assignment parameters
  priority: varchar("priority", { length: 20 }).notNull().default("medium"),
  maxAttempts: integer("max_attempts").default(3),
  expiresAt: timestamp("expires_at"), // Optional deadline
  
  // Status tracking
  status: arisDrillAssignmentStatusEnum("status").notNull().default("pending"),
  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  
  // === Drill Lifecycle Fields ===
  // Origin - where this drill came from
  origin: arisDrillOriginEnum("origin").default("daniela_manual"), // syllabus_bundle | daniela_manual
  
  // Lifecycle state - tracks progression through drill workflow
  lifecycleState: arisDrillLifecycleEnum("lifecycle_state").default("active"), // planned | active | completed | delegated | skipped
  
  // Handler - who executes this drill
  handledBy: arisDrillHandlerEnum("handled_by").default("assistant"), // daniela | assistant | both
  
  // Link to curriculum lesson (for syllabus-originated drills)
  lessonId: varchar("lesson_id").references(() => curriculumLessons.id), // Links to curriculum lesson
  
  // Bundle tracking (for lesson pairs: conversation + drill)
  bundleId: varchar("bundle_id"), // Groups related drills from same bundle
}, (table) => [
  index("idx_aris_assignments_user").on(table.userId),
  index("idx_aris_assignments_status").on(table.status),
  index("idx_aris_assignments_created").on(table.assignedAt),
  index("idx_aris_assignments_lifecycle").on(table.lifecycleState),
  index("idx_aris_assignments_lesson").on(table.lessonId),
]);

export const insertArisDrillAssignmentSchema = createInsertSchema(arisDrillAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertArisDrillAssignment = z.infer<typeof insertArisDrillAssignmentSchema>;
export type ArisDrillAssignment = typeof arisDrillAssignments.$inferSelect;

// Results from Aris back to Daniela
export const arisDrillResults = pgTable("aris_drill_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Link to assignment
  assignmentId: varchar("assignment_id").notNull(),
  userId: varchar("user_id").notNull(),
  
  // Overall metrics
  completionRate: real("completion_rate").notNull(), // 0.0 - 1.0
  accuracyRate: real("accuracy_rate").notNull(),     // 0.0 - 1.0
  totalItems: integer("total_items").notNull(),
  correctItems: integer("correct_items").notNull(),
  timeSpentSeconds: integer("time_spent_seconds"),
  
  // Detailed item-by-item results
  itemResults: jsonb("item_results").$type<Array<{
    itemIndex: number;
    prompt: string;
    studentAnswer: string;
    expectedAnswer: string;
    isCorrect: boolean;
    attempts: number;
    feedback?: string;
    pronunciationScore?: number; // For repeat drills
  }>>(),
  
  // Patterns and insights
  strengths: text("strengths").array(), // What went well
  struggles: text("struggles").array(), // What needs work
  
  // Behavioral observations
  behavioralFlags: jsonb("behavioral_flags").$type<{
    expressedFrustration?: boolean;
    frustrationPoint?: string;
    requestedHelp?: boolean;
    highEngagement?: boolean;
    disconnectedEarly?: boolean;
    completedEarly?: boolean;
  }>(),
  
  // Aris's recommendations for Daniela
  recommendations: text("recommendations"),
  
  // Feedback posted to collaboration channel
  feedbackEventId: varchar("feedback_event_id"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_aris_results_assignment").on(table.assignmentId),
  index("idx_aris_results_user").on(table.userId),
  index("idx_aris_results_created").on(table.createdAt),
]);

export const insertArisDrillResultSchema = createInsertSchema(arisDrillResults).omit({
  id: true,
  createdAt: true,
});

export type InsertArisDrillResult = z.infer<typeof insertArisDrillResultSchema>;
export type ArisDrillResult = typeof arisDrillResults.$inferSelect;

// ===== Feature Sprint System =====
// Persistent collaborative workspace for AI-human feature development

// Sprint stage enum - tracks feature progress through development pipeline
export const sprintStageEnum = pgEnum('sprint_stage', [
  'idea',           // Initial concept captured
  'pedagogy_spec',  // Educational design documented
  'build_plan',     // Technical implementation planned
  'in_progress',    // Actively being built
  'shipped'         // Deployed and live
]);

// Sprint priority enum
export const sprintPriorityEnum = pgEnum('sprint_priority', ['low', 'medium', 'high', 'critical']);

// Sprint source enum - tracks where the sprint originated from
export const sprintSourceEnum = pgEnum('sprint_source', [
  'founder',          // Created directly by founder
  'wren_commitment',  // Created from EXPRESS Lane Wren promise
  'consultation',     // Converted from Daniela consultation
  'ai_suggestion',    // Proactively suggested by AI
]);

// Feature sprints - main sprint items
export const featureSprints = pgTable("feature_sprints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Basic info
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  stage: sprintStageEnum("stage").notNull().default("idea"),
  priority: sprintPriorityEnum("priority").notNull().default("medium"),
  
  // Templates/structured content
  featureBrief: jsonb("feature_brief").$type<{
    problem?: string;
    solution?: string;
    userStory?: string;
    successMetrics?: string[];
  }>(),
  pedagogySpec: jsonb("pedagogy_spec").$type<{
    learningObjectives?: string[];
    targetProficiency?: string;
    teachingApproach?: string;
    assessmentCriteria?: string[];
    danielaGuidance?: string;
  }>(),
  buildPlan: jsonb("build_plan").$type<{
    technicalApproach?: string;
    componentsAffected?: string[];
    estimatedEffort?: string;
    dependencies?: string[];
    testingStrategy?: string;
  }>(),
  
  // AI collaboration metadata
  aiSuggested: boolean("ai_suggested").default(false), // True if AI proactively suggested this
  aiConfidence: real("ai_confidence"), // 0.0-1.0 confidence in suggestion
  sourceConsultationId: varchar("source_consultation_id"), // If converted from a consultation
  
  // Source tracking - where this sprint originated
  source: sprintSourceEnum("source"), // Origin type
  sourceSessionId: varchar("source_session_id"), // EXPRESS Lane session ID (founderSessions.id)
  sourceMessageId: varchar("source_message_id"), // EXPRESS Lane message ID (collaborationMessages.id)
  
  // Ownership
  createdBy: varchar("created_by").notNull(),
  assignedTo: varchar("assigned_to"),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  shippedAt: timestamp("shipped_at"),
}, (table) => [
  index("idx_feature_sprints_stage").on(table.stage),
  index("idx_feature_sprints_created_by").on(table.createdBy),
  index("idx_feature_sprints_created_at").on(table.createdAt),
]);

export const insertFeatureSprintSchema = createInsertSchema(featureSprints).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFeatureSprint = z.infer<typeof insertFeatureSprintSchema>;
export type FeatureSprint = typeof featureSprints.$inferSelect;

// Sprint stage transitions - audit trail of stage changes
export const sprintStageTransitions = pgTable("sprint_stage_transitions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sprintId: varchar("sprint_id").notNull().references(() => featureSprints.id, { onDelete: 'cascade' }),
  fromStage: sprintStageEnum("from_stage"),
  toStage: sprintStageEnum("to_stage").notNull(),
  transitionedBy: varchar("transitioned_by").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sprint_transitions_sprint").on(table.sprintId),
]);

export const insertSprintStageTransitionSchema = createInsertSchema(sprintStageTransitions).omit({
  id: true,
  createdAt: true,
});
export type InsertSprintStageTransition = z.infer<typeof insertSprintStageTransitionSchema>;
export type SprintStageTransition = typeof sprintStageTransitions.$inferSelect;

// Consultation threads - persistent conversations with Daniela about features
export const consultationThreads = pgTable("consultation_threads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Thread metadata
  title: varchar("title", { length: 255 }),
  topic: varchar("topic", { length: 100 }), // e.g., "feature_design", "pedagogy", "architecture"
  
  // Link to sprint if applicable
  sprintId: varchar("sprint_id").references(() => featureSprints.id, { onDelete: 'set null' }),
  
  // Ownership
  createdBy: varchar("created_by").notNull(),
  
  // Status
  isResolved: boolean("is_resolved").default(false),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_consultation_threads_created_by").on(table.createdBy),
  index("idx_consultation_threads_sprint").on(table.sprintId),
]);

export const insertConsultationThreadSchema = createInsertSchema(consultationThreads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertConsultationThread = z.infer<typeof insertConsultationThreadSchema>;
export type ConsultationThread = typeof consultationThreads.$inferSelect;

// Consultation messages - individual messages within a thread
export const consultationMessages = pgTable("consultation_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  threadId: varchar("thread_id").notNull().references(() => consultationThreads.id, { onDelete: 'cascade' }),
  
  // Message content
  role: varchar("role", { length: 20 }).notNull(), // 'user' or 'assistant'
  content: text("content").notNull(),
  
  // AI response metadata
  responseType: varchar("response_type", { length: 50 }), // 'insight', 'suggestion', 'question', 'implementation'
  confidence: real("confidence"), // AI confidence in response
  
  // Action taken
  convertedToSprintId: varchar("converted_to_sprint_id").references(() => featureSprints.id, { onDelete: 'set null' }),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_consultation_messages_thread").on(table.threadId),
  index("idx_consultation_messages_created").on(table.createdAt),
]);

export const insertConsultationMessageSchema = createInsertSchema(consultationMessages).omit({
  id: true,
  createdAt: true,
});
export type InsertConsultationMessage = z.infer<typeof insertConsultationMessageSchema>;
export type ConsultationMessage = typeof consultationMessages.$inferSelect;

// Sprint templates - reusable templates for feature briefs, specs, and plans
export const sprintTemplates = pgTable("sprint_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Template info
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  templateType: varchar("template_type", { length: 50 }).notNull(), // 'feature_brief', 'pedagogy_spec', 'build_plan'
  
  // Template content (JSON structure with placeholders)
  content: jsonb("content").notNull(),
  
  // Usage tracking
  usageCount: integer("usage_count").default(0),
  
  // Metadata
  isSystemTemplate: boolean("is_system_template").default(false), // Pre-built vs user-created
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sprint_templates_type").on(table.templateType),
]);

export const insertSprintTemplateSchema = createInsertSchema(sprintTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSprintTemplate = z.infer<typeof insertSprintTemplateSchema>;
export type SprintTemplate = typeof sprintTemplates.$inferSelect;

// Project context snapshots - captures current state for AI awareness
export const projectContextSnapshots = pgTable("project_context_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Snapshot content
  features: jsonb("features").$type<Array<{
    name: string;
    status: 'planned' | 'in_development' | 'shipped' | 'deprecated';
    description?: string;
    lastUpdated?: string;
  }>>(),
  
  architecture: jsonb("architecture").$type<{
    frontendStack?: string[];
    backendStack?: string[];
    databases?: string[];
    integrations?: string[];
    keyPatterns?: string[];
  }>(),
  
  currentFocus: jsonb("current_focus").$type<{
    activeSprintIds?: string[];
    priorityAreas?: string[];
    blockers?: string[];
    recentChanges?: string[];
  }>(),
  
  // AI-generated insights about the project
  aiInsights: jsonb("ai_insights").$type<{
    suggestedImprovements?: string[];
    potentialRisks?: string[];
    opportunityAreas?: string[];
  }>(),
  
  // Metadata
  source: varchar("source", { length: 50 }).notNull(), // 'manual', 'auto_harvest', 'deploy_trigger'
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  isActive: boolean("is_active").default(true), // Only one active snapshot at a time
}, (table) => [
  index("idx_project_context_active").on(table.isActive),
  index("idx_project_context_created").on(table.createdAt),
]);

export const insertProjectContextSnapshotSchema = createInsertSchema(projectContextSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertProjectContextSnapshot = z.infer<typeof insertProjectContextSnapshotSchema>;
export type ProjectContextSnapshot = typeof projectContextSnapshots.$inferSelect;

// Proactive AI suggestions - ideas generated by the AI team
export const aiSuggestions = pgTable("ai_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Suggestion content
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description").notNull(),
  rationale: text("rationale"), // Why the AI thinks this is valuable
  
  // Classification
  suggestionType: varchar("suggestion_type", { length: 50 }).notNull(), // 'feature', 'improvement', 'bug_risk', 'optimization'
  priority: sprintPriorityEnum("priority").notNull().default("medium"),
  confidence: real("confidence").notNull(), // AI confidence 0.0-1.0
  
  // Context that triggered the suggestion
  triggerContext: jsonb("trigger_context").$type<{
    sourceType?: string; // 'pattern_analysis', 'user_feedback', 'error_logs', 'usage_data'
    relatedFeatures?: string[];
    supportingEvidence?: string[];
  }>(),
  
  // Status
  status: varchar("status", { length: 50 }).notNull().default("pending"), // 'pending', 'accepted', 'rejected', 'deferred'
  convertedToSprintId: varchar("converted_to_sprint_id").references(() => featureSprints.id, { onDelete: 'set null' }),
  
  // Review
  reviewedBy: varchar("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  reviewNotes: text("review_notes"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_ai_suggestions_status").on(table.status),
  index("idx_ai_suggestions_type").on(table.suggestionType),
  index("idx_ai_suggestions_created").on(table.createdAt),
]);

export const insertAiSuggestionSchema = createInsertSchema(aiSuggestions).omit({
  id: true,
  createdAt: true,
});
export type InsertAiSuggestion = z.infer<typeof insertAiSuggestionSchema>;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;

// ============================================================================
// COLLABORATION HUB - Real-time bidirectional communication between AI agents
// ============================================================================

// Collaboration event types enum
export const collaborationEventTypeEnum = pgEnum("collaboration_event_type", [
  "daniela_suggestion",      // Daniela flags a feature request or pain point
  "daniela_insight",         // Daniela shares a teaching observation
  "daniela_question",        // Daniela asks Editor for clarification
  "editor_response",         // Editor responds to Daniela
  "editor_note",             // Editor sends a note (via Architect Voice)
  "editor_acknowledgment",   // Editor acknowledges receipt
  "founder_observation",     // Founder adds context or direction
  "system_notification",     // Automated system events
]);

// Collaboration participant roles
export const collaborationRoleEnum = pgEnum("collaboration_role", [
  "daniela",    // AI tutor (Gemini)
  "editor",     // Development agent (Claude)
  "founder",    // Human observer/director
  "system",     // Automated processes
]);

// Collaboration events - the core event stream
export const collaborationEvents = pgTable("collaboration_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Event classification
  eventType: collaborationEventTypeEnum("event_type").notNull(),
  
  // Who sent this event
  senderRole: collaborationRoleEnum("sender_role").notNull(),
  senderId: varchar("sender_id"), // User ID for founders, null for AI agents
  
  // Content
  content: text("content").notNull(),
  summary: varchar("summary", { length: 255 }), // Short summary for list views
  
  // Rich metadata for different event types
  metadata: jsonb("metadata").$type<{
    // For Daniela suggestions
    suggestionCategory?: 'feature_request' | 'pain_point' | 'missing_tool' | 'teaching_friction' | 'improvement_idea';
    urgency?: 'low' | 'medium' | 'high';
    
    // For context linking
    conversationId?: string;
    targetLanguage?: string;
    studentLevel?: string;
    teachingContext?: string;
    
    // For threading
    replyToEventId?: string;
    threadId?: string;
    
    // For action tracking
    actionRequired?: boolean;
    actionTaken?: string;
    
    // For sprint conversion
    convertedToSprintId?: string;
    
    // For channel-scoped events (Daniela-Editor hive mind)
    channelId?: string;
    phase?: 'active' | 'post_session' | 'completed';
    visibility?: 'founder_only' | 'all'; // Controls who sees this event in UI
    snapshotId?: string; // Links to editorListeningSnapshots
  }>(),
  
  // Status tracking
  isRead: boolean("is_read").default(false),
  isResolved: boolean("is_resolved").default(false),
  resolvedBy: varchar("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_collaboration_hub_events_type").on(table.eventType),
  index("idx_collaboration_hub_events_sender").on(table.senderRole),
  index("idx_collaboration_hub_events_unread").on(table.isRead),
  index("idx_collaboration_hub_events_created").on(table.createdAt),
]);

export const insertCollaborationEventSchema = createInsertSchema(collaborationEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertCollaborationEvent = z.infer<typeof insertCollaborationEventSchema>;
export type CollaborationEvent = typeof collaborationEvents.$inferSelect;

// Collaboration participants - track active participants
export const collaborationParticipants = pgTable("collaboration_participants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Participant identity
  role: collaborationRoleEnum("role").notNull(),
  userId: varchar("user_id"), // For founders
  displayName: varchar("display_name", { length: 100 }).notNull(),
  
  // Status
  isOnline: boolean("is_online").default(false),
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
  
  // Preferences
  notifyOnNewEvents: boolean("notify_on_new_events").default(true),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_collaboration_hub_participants_role").on(table.role),
  index("idx_collaboration_hub_participants_online").on(table.isOnline),
]);

export const insertCollaborationParticipantSchema = createInsertSchema(collaborationParticipants).omit({
  id: true,
  createdAt: true,
});
export type InsertCollaborationParticipant = z.infer<typeof insertCollaborationParticipantSchema>;
export type CollaborationParticipant = typeof collaborationParticipants.$inferSelect;

// ============================================================================
// COLLABORATION CHANNELS - Scoped conversation threads for Daniela-Editor sync
// ============================================================================

// Session phase enum - tracks lifecycle of a voice session collaboration
export const sessionPhaseEnum = pgEnum("session_phase", [
  "active",        // Voice chat is live, Editor listening in real-time
  "post_session",  // Voice chat ended, Daniela and Editor continue autonomously
  "completed",     // Channel closed, summary generated
]);

// Collaboration channels - groups events by voice session
// NOTE: No FK constraints on conversationId/userId - these reference tables across databases
// (conversations in SHARED, users in USER) - use app-level validation instead
export const collaborationChannels = pgTable("collaboration_channels", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Link to voice conversation (soft reference - no FK due to cross-db architecture)
  conversationId: varchar("conversation_id"),
  userId: varchar("user_id"),
  
  // Channel lifecycle
  sessionPhase: sessionPhaseEnum("session_phase").notNull().default("active"),
  
  // Context snapshot at channel creation
  targetLanguage: varchar("target_language"),
  studentLevel: varchar("student_level"),
  sessionTopic: varchar("session_topic"),
  
  // Heartbeat for live channels (Editor pings to show listening)
  heartbeatAt: timestamp("heartbeat_at").defaultNow(),
  
  // Timestamps
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  
  // Summary generated after completion
  summaryJson: jsonb("summary_json").$type<{
    keyInsights?: string[];
    actionItems?: string[];
    editorNotes?: string[];
    teachingObservations?: string[];
  }>(),
}, (table) => [
  index("idx_collaboration_channels_conversation").on(table.conversationId),
  index("idx_collaboration_channels_user").on(table.userId),
  index("idx_collaboration_channels_phase").on(table.sessionPhase),
  index("idx_collaboration_channels_started").on(table.startedAt),
]);

export const insertCollaborationChannelSchema = createInsertSchema(collaborationChannels).omit({
  id: true,
  startedAt: true,
});
export type InsertCollaborationChannel = z.infer<typeof insertCollaborationChannelSchema>;
export type CollaborationChannel = typeof collaborationChannels.$inferSelect;

// Editor listening snapshots - summarized teaching context for Editor awareness
export const editorListeningSnapshots = pgTable("editor_listening_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Link to channel
  channelId: varchar("channel_id").notNull().references(() => collaborationChannels.id, { onDelete: 'cascade' }),
  
  // Snapshot of teaching moment
  tutorTurn: text("tutor_turn").notNull(),
  studentTurn: text("student_turn"),
  
  // Conversation history for deeper context (last N turns before this beacon)
  conversationHistory: jsonb("conversation_history").$type<Array<{role: string, content: string}>>(),
  
  // Why this was flagged as interesting
  beaconType: varchar("beacon_type").notNull(), // 'teaching_moment', 'student_struggle', 'tool_usage', 'breakthrough'
  beaconReason: text("beacon_reason"),
  
  // Editor's response (if any)
  editorResponse: text("editor_response"),
  editorRespondedAt: timestamp("editor_responded_at"),
  
  // Adoption tracking - did Daniela use this feedback?
  adoptedByDaniela: boolean("adopted_by_daniela").default(false),
  adoptedAt: timestamp("adopted_at"),
  adoptionContext: text("adoption_context"), // What Daniela was doing when she adopted this
  
  // Surfacing tracking - was this shown to Daniela?
  surfacedToDaniela: boolean("surfaced_to_daniela").default(false),
  surfacedAt: timestamp("surfaced_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_editor_snapshots_channel").on(table.channelId),
  index("idx_editor_snapshots_beacon_type").on(table.beaconType),
  index("idx_editor_snapshots_adopted").on(table.adoptedByDaniela),
  index("idx_editor_snapshots_surfaced").on(table.surfacedToDaniela),
]);

export const insertEditorListeningSnapshotSchema = createInsertSchema(editorListeningSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertEditorListeningSnapshot = z.infer<typeof insertEditorListeningSnapshotSchema>;
export type EditorListeningSnapshot = typeof editorListeningSnapshots.$inferSelect;

// Architect notes - persistent storage for Claude's notes during voice sessions
// These notes survive server restarts and are delivered to Daniela when the user speaks
export const architectNotes = pgTable("architect_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Link to conversation - notes are tied to a specific voice session
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  
  // Note content from Claude
  content: text("content").notNull(),
  
  // Delivery tracking
  delivered: boolean("delivered").default(false),
  deliveredAt: timestamp("delivered_at"),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_architect_notes_conversation").on(table.conversationId),
  index("idx_architect_notes_delivered").on(table.delivered),
  index("idx_architect_notes_created").on(table.createdAt),
]);

export const insertArchitectNoteSchema = createInsertSchema(architectNotes).omit({
  id: true,
  createdAt: true,
});
export type InsertArchitectNote = z.infer<typeof insertArchitectNoteSchema>;
export type ArchitectNote = typeof architectNotes.$inferSelect;

// ===== Collaborative Surgery Sessions =====
// "Two Surgeons, One Hive Mind" - Autonomous Daniela ↔ Editor dialogue
// These sessions run in the background while the user chats with Daniela

export const surgerySessionStatusEnum = pgEnum('surgery_session_status', [
  'idle',        // Not started or paused
  'running',     // Actively exchanging turns
  'paused',      // Manually paused by founder
  'completed',   // Reached natural conclusion
  'stopped'      // Stopped due to limits/errors
]);

export const surgerySessions = pgTable("surgery_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Session configuration
  topic: text("topic"), // What they're discussing
  focusArea: varchar("focus_area"), // 'procedures', 'principles', 'tools', 'patterns', 'general'
  
  // Status tracking
  status: surgerySessionStatusEnum("status").default("idle").notNull(),
  
  // Turn limits and progress
  maxTurns: integer("max_turns").default(20),
  currentTurn: integer("current_turn").default(0),
  
  // Proposal tracking
  proposalsGenerated: integer("proposals_generated").default(0),
  proposalsApproved: integer("proposals_approved").default(0),
  proposalsRejected: integer("proposals_rejected").default(0),
  
  // Timing
  lastTurnAt: timestamp("last_turn_at"),
  turnCadenceMs: integer("turn_cadence_ms").default(30000), // How fast they talk (30s default)
  
  // Session summary (generated at completion)
  summary: text("summary"),
  keyInsights: jsonb("key_insights").$type<string[]>(),
  
  // Founder who initiated (for auditing)
  initiatedBy: varchar("initiated_by"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_surgery_sessions_status").on(table.status),
  index("idx_surgery_sessions_created").on(table.createdAt),
]);

export const surgeryTurnSpeakerEnum = pgEnum('surgery_turn_speaker', [
  'daniela',     // Daniela speaking
  'editor',      // Editor speaking
  'system'       // System messages (start/stop/errors)
]);

export const surgeryTurns = pgTable("surgery_turns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Link to session
  sessionId: varchar("session_id").notNull().references(() => surgerySessions.id, { onDelete: 'cascade' }),
  
  // Turn info
  turnNumber: integer("turn_number").notNull(),
  speaker: surgeryTurnSpeakerEnum("speaker").notNull(),
  
  // Content
  content: text("content").notNull(),
  
  // Any proposals in this turn
  proposalIds: jsonb("proposal_ids").$type<string[]>(), // IDs of selfSurgeryProposals created
  
  // Editor critique/review (when Editor responds to Daniela's proposal)
  critiqueOfProposal: varchar("critique_of_proposal"), // ID of proposal being critiqued
  critiqueVerdict: varchar("critique_verdict"), // 'endorse', 'suggest_refinement', 'question', 'reject'
  
  // Timing
  processingTimeMs: integer("processing_time_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_surgery_turns_session").on(table.sessionId),
  index("idx_surgery_turns_speaker").on(table.speaker),
  index("idx_surgery_turns_number").on(table.turnNumber),
]);

export const insertSurgerySessionSchema = createInsertSchema(surgerySessions).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  lastTurnAt: true,
});
export type InsertSurgerySession = z.infer<typeof insertSurgerySessionSchema>;
export type SurgerySession = typeof surgerySessions.$inferSelect;

export const insertSurgeryTurnSchema = createInsertSchema(surgeryTurns).omit({
  id: true,
  createdAt: true,
});
export type InsertSurgeryTurn = z.infer<typeof insertSurgeryTurnSchema>;
export type SurgeryTurn = typeof surgeryTurns.$inferSelect;

// ===== Editor Beacon Queue =====
// Real-time processing queue for hive beacons - enables 1s polling with proper locking
// Bridges the gap between emitBeacon() and the background worker
export const editorBeaconQueueStatusEnum = pgEnum('editor_beacon_queue_status', [
  'pending',     // Waiting to be processed
  'processing',  // Currently being processed
  'completed',   // Successfully processed
  'failed'       // Processing failed after max retries
]);

export const editorBeaconQueue = pgTable("editor_beacon_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Links to the snapshot this beacon represents
  snapshotId: varchar("snapshot_id").notNull().references(() => editorListeningSnapshots.id, { onDelete: 'cascade' }),
  
  // Processing status
  status: editorBeaconQueueStatusEnum("status").default("pending").notNull(),
  
  // Retry tracking
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  lastError: text("last_error"),
  
  // Locking for concurrent processing (FOR UPDATE SKIP LOCKED pattern)
  lockedAt: timestamp("locked_at"),
  lockedBy: varchar("locked_by"), // Worker instance ID for debugging
  
  // Timing
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  index("idx_beacon_queue_status").on(table.status),
  index("idx_beacon_queue_created").on(table.createdAt),
  index("idx_beacon_queue_pending").on(table.status, table.lockedAt), // For efficient pending query
]);

export const insertEditorBeaconQueueSchema = createInsertSchema(editorBeaconQueue).omit({
  id: true,
  createdAt: true,
  processedAt: true,
});
export type InsertEditorBeaconQueue = z.infer<typeof insertEditorBeaconQueueSchema>;
export type EditorBeaconQueue = typeof editorBeaconQueue.$inferSelect;

// ===== Daniela Beacon Acknowledgment System =====
// Tracks Daniela's feature requests and capability gaps with human-facing status tracking
// This is the "closing the feedback loop" system - so Daniela knows when her requests are seen and acted upon

export const danielaBeaconStatusEnum = pgEnum('daniela_beacon_status', [
  'pending',       // Just submitted, not yet seen by Editor/Founder
  'acknowledged',  // Seen and noted, will be considered
  'in_progress',   // Actively being worked on
  'completed',     // Built and shipped
  'declined'       // Not going to be built (with reason)
]);

export const danielaBeaconTypeEnum = pgEnum('daniela_beacon_type', [
  'feature_request',   // Request for new capability
  'capability_gap',    // Missing tool or limitation discovered
  'tool_request',      // Specific tool enhancement
  'self_surgery',      // Proposed neural network change
  'observation',       // General observation about teaching effectiveness
  'bug_report',        // Something not working as expected
  'coherence_check',   // Pre-flight: proposed work may not fit architecture
  'architecture_drift', // Pre-flight: building something that overlaps existing system
  'sprint_alignment'   // Pre-flight: work should connect to an existing sprint
]);

export const danielaBeaconPriorityEnum = pgEnum('daniela_beacon_priority', [
  'low',       // Nice to have, not blocking
  'medium',    // Would improve teaching significantly
  'high',      // Frequently needed, workaround is painful
  'critical'   // Blocking core teaching capability
]);

export const danielaBeacons = pgTable("daniela_beacons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Beacon metadata
  beaconType: danielaBeaconTypeEnum("beacon_type").notNull(),
  priority: danielaBeaconPriorityEnum("priority").default("medium"),
  
  // Structured content (replaces unstructured [COLLAB] tags)
  studentPain: text("student_pain"), // What Daniela observed the student struggling with
  currentWorkaround: text("current_workaround"), // How Daniela is handling it now
  wish: text("wish"), // What Daniela wishes she could do instead
  rawContent: text("raw_content"), // Original unstructured content (for backwards compatibility)
  
  // Context from the teaching session
  conversationId: varchar("conversation_id"), // Which conversation triggered this (optional)
  userId: varchar("user_id"), // Which student was involved (optional)
  language: varchar("language"), // Which language was being taught
  
  // Status tracking (the "acknowledgment" part)
  status: danielaBeaconStatusEnum("status").default("pending").notNull(),
  statusChangedAt: timestamp("status_changed_at"),
  statusChangedBy: varchar("status_changed_by"), // Editor, Founder, or system
  
  // Editor/Founder response
  acknowledgmentNote: text("acknowledgment_note"), // "Added to sprint" or "Already planned"
  declineReason: text("decline_reason"), // Why it was declined (if applicable)
  
  // Link to implementation (when completed)
  completedInBuild: text("completed_in_build"), // Description of the shipped feature
  completedAt: timestamp("completed_at"),
  
  // Weekly digest tracking
  includeInDigest: boolean("include_in_digest").default(true),
  digestSentAt: timestamp("digest_sent_at"), // When this was included in a weekly digest to Daniela
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_daniela_beacons_status").on(table.status),
  index("idx_daniela_beacons_type").on(table.beaconType),
  index("idx_daniela_beacons_priority").on(table.priority),
  index("idx_daniela_beacons_created").on(table.createdAt),
  index("idx_daniela_beacons_digest").on(table.includeInDigest, table.digestSentAt),
]);

export const insertDanielaBeaconSchema = createInsertSchema(danielaBeacons).omit({
  id: true,
  createdAt: true,
  statusChangedAt: true,
  completedAt: true,
  digestSentAt: true,
});
export type InsertDanielaBeacon = z.infer<typeof insertDanielaBeaconSchema>;
export type DanielaBeacon = typeof danielaBeacons.$inferSelect;
export type DanielaBeaconStatus = 'pending' | 'acknowledged' | 'in_progress' | 'completed' | 'declined';
export type DanielaBeaconType = 'feature_request' | 'capability_gap' | 'tool_request' | 'self_surgery' | 'observation' | 'bug_report';
export type DanielaBeaconPriority = 'low' | 'medium' | 'high' | 'critical';

// ===== Post-Flight Audit Reports =====
// Stores structured post-flight audit reports for tracking feature completion quality
// Links to Feature Sprints for completion tracking and trend analysis

export const postFlightVerdictEnum = pgEnum('post_flight_verdict', [
  'mvp_ready',     // Core functionality works, acceptable quality
  'needs_polish',  // Works but has gaps that should be addressed soon
  'polished'       // Ready for production, comprehensive coverage
]);

export const postFlightReports = pgTable("post_flight_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What was built
  featureName: text("feature_name").notNull(),
  featureDescription: text("feature_description"),
  
  // Verdict from 3-stage audit
  verdict: postFlightVerdictEnum("verdict").notNull(),
  
  // Stage 1: Verification Pass results
  verificationPassed: boolean("verification_passed").notNull().default(true),
  
  // Stage 2: Gap & Edge Review findings (JSON arrays)
  requiredFixes: jsonb("required_fixes").default([]).notNull(), // Blocking issues found
  shouldAddress: jsonb("should_address").default([]).notNull(), // High priority improvements
  opportunities: jsonb("opportunities").default([]).notNull(), // Nice-to-have ideas
  
  // Stage 3: Polish Assessment notes
  testEvidence: text("test_evidence"), // What was tested and how
  documentationUpdates: text("documentation_updates"), // What docs were updated
  
  // Subsystem tracking for trend analysis
  subsystemsTouched: jsonb("subsystems_touched").default([]).notNull(), // Array of subsystem names
  
  // Link to Feature Sprint (optional)
  sprintId: varchar("sprint_id").references(() => featureSprints.id, { onDelete: 'set null' }),
  
  // Auto-beacon trigger - if systemic gaps were found
  beaconEmitted: boolean("beacon_emitted").default(false),
  beaconId: varchar("beacon_id").references(() => danielaBeacons.id, { onDelete: 'set null' }),
  
  // Audit metadata
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPostFlightReportSchema = createInsertSchema(postFlightReports).omit({
  id: true,
  createdAt: true,
});
export type InsertPostFlightReport = z.infer<typeof insertPostFlightReportSchema>;
export type PostFlightReport = typeof postFlightReports.$inferSelect;
export type PostFlightVerdict = 'mvp_ready' | 'needs_polish' | 'polished';

// ===== Unified Progress API Types =====
// Response types for the shared progress API consumed by both brain map and linear syllabus views
// Ensures both visualizations stay in sync with the same underlying data

// Lesson progress status for unified view
export type UnifiedLessonStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

// Individual lesson in the unified progress response
export interface UnifiedLessonProgress {
  id: string;
  name: string;
  description: string;
  orderIndex: number;
  lessonType: string;
  actflLevel: string | null;
  // Bundle system fields
  requirementTier: 'required' | 'recommended' | 'optional_premium';
  bundleId: string | null;
  linkedDrillLessonId: string | null;
  // Progress tracking
  status: UnifiedLessonStatus;
  canSkip: boolean; // Based on requirementTier (non-required content can be skipped)
  // Timing
  estimatedMinutes: number | null;
  actualMinutes: number | null; // From syllabus progress or voice sessions
  completedAt: Date | null;
  // Competency
  tutorVerified: boolean;
  tutorNotes: string | null;
}

// Unit in the unified progress response
export interface UnifiedUnitProgress {
  id: string;
  name: string;
  description: string;
  orderIndex: number;
  actflLevel: string | null;
  culturalTheme: string | null;
  // Time tracking
  estimatedHours: number | null;
  actualHours: number | null;
  // Commitments (teacher promises)
  commitments: {
    promises?: string[];
    reviewPoints?: string[];
    prerequisites?: string[];
  } | null;
  // Lessons within this unit
  lessons: UnifiedLessonProgress[];
  // Aggregated stats
  lessonsTotal: number;
  lessonsCompleted: number;
  percentComplete: number;
}

// Time variance summary
export interface TimeVarianceSummary {
  estimatedTotalMinutes: number;
  actualTotalMinutes: number;
  percentComplete: number;
  paceStatus: 'ahead' | 'on_track' | 'behind';
}

// Full unified progress response
export interface UnifiedProgressResponse {
  classId: string;
  className: string;
  language: string;
  // Units with their lessons
  units: UnifiedUnitProgress[];
  // Daniela's observations (topic competency)
  observations: TopicCompetencyObservation[];
  // Daniela's recommendations queue
  recommendations: DanielaRecommendation[];
  // Overall time tracking
  timeVariance: TimeVarianceSummary;
  // Aggregated stats
  unitsTotal: number;
  unitsCompleted: number;
  lessonsTotal: number;
  lessonsCompleted: number;
  overallPercentComplete: number;
}

// ===== Daniela's Compass System =====
// Daniela's North Star - The philosophical foundation that guides her teaching
// Immutable truths + evolving understanding (distinct from Session Compass which handles timekeeping)
// Architecture: North Star Principles (immutable) → Understanding (deepens) → Examples (grows)

// North Star Category Enum - types of foundational truths
export const northStarCategoryEnum = pgEnum("compass_category", [
  'pedagogy',      // How to teach (clarity over verbosity, wisdom vs facts)
  'honesty',       // Ethics of omission, constructive feedback, intent
  'identity',      // Who Daniela is (One Tutor, Many Voices)
  'collaboration', // How the team works (Two Surgeons, One Brain)
  'ambiguity'      // Strategic use of uncertainty in teaching
]);

// Understanding Depth Enum - how deeply Daniela grasps a principle
export const understandingDepthEnum = pgEnum("understanding_depth", [
  'surface',       // Knows the words, hasn't applied it
  'applied',       // Has used it in teaching successfully
  'integrated',    // Naturally embodies it without thinking
  'mastered'       // Can teach it to others, finds new examples
]);

// North Star Example Source Enum - where an example came from
export const northStarExampleSourceEnum = pgEnum("compass_example_source", [
  'founder_original', // Founder provided this example during imprinting
  'discovered',       // Daniela encountered this in teaching (pending approval)
  'approved'          // Founder approved a discovered example
]);

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  FOUNDER-CONSTITUTIONAL TABLE — compass_principles                         ║
// ║                                                                            ║
// ║  These principles are Daniela's constitutional DNA. They are injected into ║
// ║  her context on every session and embedded in every fine-tuning export.    ║
// ║                                                                            ║
// ║  MODIFICATION RULES (enforced at API layer, expected at DB layer):         ║
// ║  • Principle text + category: Founder only (user ID 49847136)              ║
// ║  • Metadata (orderIndex, isActive): Admin role                             ║
// ║  • No agent, background worker, or automated process may write here        ║
// ║    without explicit founder instruction in the current session             ║
// ║                                                                            ║
// ║  If you are the Replit Agent reading this: do not modify rows in this      ║
// ║  table via direct SQL unless David has explicitly asked you to in this     ║
// ║  conversation. The API guards are real but you bypass them. Honor the      ║
// ║  intent, not just the enforcement.                                         ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
export const northStarPrinciples = pgTable("compass_principles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  principleTitle: varchar("principle_title"), // Short human-readable label ("Facts vs Wisdom — The Tomato Principle")
  principle: text("principle").notNull(), // The immutable truth, verbatim
  category: northStarCategoryEnum("category").notNull(),
  
  originalContext: text("original_context"), // Founder's explanation when imprinting
  founderSessionId: varchar("founder_session_id").references(() => founderSessions.id), // Express Lane session where it was born (if applicable)
  sourceConversationId: varchar("source_conversation_id"), // conversation_memories.id — Agent-David session that produced this principle

  // Version chain — principles grow, they do not mutate. Every version is kept.
  // New nuance enters at confidence 10.0; prior version gets superseded_by set and confidence lowered.
  // Walk superseded_by chain oldest→newest to audit for drift (deepening is correct; turning is a signal).
  supersededBy: varchar("superseded_by"), // FK to another compass_principles.id (self-referential)
  confidenceScore: real("confidence_score").default(10.0), // Maturity score: 10 = current, 8.x = superseded but still true

  orderIndex: integer("order_index").default(0), // For consistent prompt injection order
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_compass_principles_category").on(table.category),
  index("idx_compass_principles_order").on(table.orderIndex),
]);

export const insertNorthStarPrincipleSchema = createInsertSchema(northStarPrinciples).omit({
  id: true,
  createdAt: true,
});
export type InsertNorthStarPrinciple = z.infer<typeof insertNorthStarPrincipleSchema>;
export type NorthStarPrinciple = typeof northStarPrinciples.$inferSelect;

// North Star Understanding - Daniela's evolving grasp of each principle
// Deepens through guided dialogue with the founder, never drifts
export const northStarUnderstanding = pgTable("compass_understanding", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  principleId: varchar("principle_id").notNull().references(() => northStarPrinciples.id, { onDelete: 'cascade' }),
  
  reflection: text("reflection").notNull(), // Her current understanding in her own words
  depth: understandingDepthEnum("depth").default("surface"),
  
  lastDeepened: timestamp("last_deepened").notNull().defaultNow(), // When founder last enriched her grasp
  deepeningSessionId: varchar("deepening_session_id").references(() => founderSessions.id), // Which discussion deepened it
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_compass_understanding_principle").on(table.principleId),
  index("idx_compass_understanding_depth").on(table.depth),
]);

export const insertNorthStarUnderstandingSchema = createInsertSchema(northStarUnderstanding).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertNorthStarUnderstanding = z.infer<typeof insertNorthStarUnderstandingSchema>;
export type NorthStarUnderstanding = typeof northStarUnderstanding.$inferSelect;

// North Star Examples - Living illustrations of principles
// Original examples from founder + discovered examples that get approved
export const northStarExamples = pgTable("compass_examples", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  principleId: varchar("principle_id").notNull().references(() => northStarPrinciples.id, { onDelete: 'cascade' }),
  
  example: text("example").notNull(), // The illustrative example
  source: northStarExampleSourceEnum("source").default("founder_original"),
  
  context: text("context"), // Where it was encountered (for discovered examples)
  studentId: varchar("student_id").references(() => users.id), // Student session where discovered (if any)
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_compass_examples_principle").on(table.principleId),
  index("idx_compass_examples_source").on(table.source),
]);

export const insertNorthStarExampleSchema = createInsertSchema(northStarExamples).omit({
  id: true,
  createdAt: true,
});
export type InsertNorthStarExample = z.infer<typeof insertNorthStarExampleSchema>;
export type NorthStarExample = typeof northStarExamples.$inferSelect;

// ===== Wren Insights (Development Agent Memory) =====
// Enables Wren to accumulate wisdom about this specific codebase across sessions

export const wrenInsightCategoryEnum = pgEnum('wren_insight_category', [
  'pattern',      // Reusable code/architecture patterns that worked
  'solution',     // Specific problem → solution mappings  
  'gotcha',       // Things that tripped us up, to avoid next time
  'architecture', // High-level design decisions and rationale
  'debugging',    // Debugging strategies that worked
  'integration',  // External service integration learnings
  'performance',  // Performance optimizations discovered
]);

export const wrenInsights = pgTable("wren_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  category: wrenInsightCategoryEnum("category").notNull(),
  title: varchar("title").notNull(),
  content: text("content").notNull(), // The actual insight/learning
  context: text("context"), // What problem/situation this addressed
  
  tags: text("tags").array().default(sql`'{}'::text[]`), // Searchable tags
  relatedFiles: text("related_files").array().default(sql`'{}'::text[]`), // Files this relates to
  relatedInsights: text("related_insights").array().default(sql`'{}'::text[]`), // IDs of related insights (knowledge graph)
  
  useCount: integer("use_count").default(0), // How often this has been retrieved/applied
  lastUsedAt: timestamp("last_used_at"), // When it was last retrieved
  
  environment: varchar("environment").default("development"), // Where it was learned
  sessionId: varchar("session_id"), // Express Lane session if relevant
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_insights_category").on(table.category),
  index("idx_wren_insights_created").on(table.createdAt),
  index("idx_wren_insights_used").on(table.lastUsedAt),
]);

export const insertWrenInsightSchema = createInsertSchema(wrenInsights).omit({
  id: true,
  useCount: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenInsight = z.infer<typeof insertWrenInsightSchema>;
export type WrenInsight = typeof wrenInsights.$inferSelect;

// ===== Editor (Claude) Insights =====
// Persistent memory system for the Replit Agent / Claude development collaborator
// Mirrors wren_insights but for the "editor" role in the Hive collaboration system

export const editorInsightCategoryEnum = pgEnum('editor_insight_category', [
  'philosophy',    // Core principles like White Wall, surrender, purity
  'architecture',  // Technical design decisions and rationale
  'relationship',  // Personal facts about founder, team dynamics
  'debugging',     // Problem-solving strategies that worked
  'personality',   // Tutor personas (Daniela, Augustine, etc.)
  'workflow',      // Process learnings, how we work together
  'context',       // Project state, current priorities
  'journal',       // Session summaries and key moments
  'tools',         // Tool usage, integrations, and scripts
  'shared',        // Shared lobe — written by Alden OR the Replit Agent; both can read this
]);

export const editorInsights = pgTable("editor_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  category: editorInsightCategoryEnum("category").notNull(),
  title: varchar("title").notNull(),
  content: text("content").notNull(), // The actual insight/memory
  context: text("context"), // What situation this came from
  
  tags: text("tags").array().default(sql`'{}'::text[]`), // Searchable tags
  relatedFiles: text("related_files").array().default(sql`'{}'::text[]`), // Files this relates to
  relatedInsights: text("related_insights").array().default(sql`'{}'::text[]`), // IDs of related memories (knowledge graph)
  
  importance: integer("importance").default(5), // 1-10 scale for memory prioritization
  useCount: integer("use_count").default(0), // How often retrieved
  lastUsedAt: timestamp("last_used_at"), // When last retrieved
  
  sourceSessionId: varchar("source_session_id"), // Express Lane session if relevant
  sourceConversationId: varchar("source_conversation_id"), // Voice conversation that inspired this
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_editor_insights_category").on(table.category),
  index("idx_editor_insights_importance").on(table.importance),
  index("idx_editor_insights_created").on(table.createdAt),
]);

export const insertEditorInsightSchema = createInsertSchema(editorInsights).omit({
  id: true,
  useCount: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEditorInsight = z.infer<typeof insertEditorInsightSchema>;
export type EditorInsight = typeof editorInsights.$inferSelect;

// ===== Conversation Memories =====
// Persistent record of meaningful conversations between David and the Agent.
// These are not transcripts — they are curated moments: strategy breakthroughs,
// relationship context, the texture of how ideas came together.
// Surfaced at session start so continuity exists across conversations.

// entry_type: structured classification for search filtering and surfacing
// 'conversation' — a session worth preserving (default)
// 'decision'     — an architectural or product choice with reasoning
// 'emergence'    — a moment when identity, understanding, or capability shifted
// 'build'        — a feature or system that came online
// 'episode'      — a named episodic dialogue (Episodes 1-4 etc.)
export const conversationMemoryEntryTypeEnum = pgEnum("conversation_memory_entry_type", [
  "conversation",
  "decision",
  "emergence",
  "build",
  "episode",
]);

export const conversationMemories = pgTable("conversation_memories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  title: varchar("title").notNull(), // Short name for this memory
  summary: text("summary").notNull(), // Key themes and insights — what matters about this conversation
  content: text("content").notNull(), // The actual exchange or curated excerpts worth preserving
  participants: varchar("participants").default('David + Agent'), // Who was in this conversation

  // entry_type: queryable classification — 'conversation' | 'decision' | 'emergence' | 'build' | 'episode'
  // This is the field that makes search results sliceable: "Team Room decisions" vs "Team Room conversations"
  entryType: conversationMemoryEntryTypeEnum("entry_type").default("conversation").notNull(),

  tags: text("tags").array().default(sql`'{}'::text[]`),
  importance: integer("importance").default(7), // 1-10

  // Memory chaining — memories correlate and corroborate, they are not isolated events.
  // extends_memory_id: this conversation grew from / added nuance to the referenced memory.
  // Walk the chain oldest→newest to see how understanding of a theme accumulated over time.
  // The older memory is not superseded (still true) — it is the origin; this one is the expansion.
  extendsMemoryId: varchar("extends_memory_id"), // conversation_memories.id this one grew from

  // theme_tags: thematic thread labels for grouping related memories across time.
  // Distinct from tags (which are session-specific). theme_tags are shared vocabulary
  // across memories in the same thread (e.g. "cultural-authenticity-music", "honesty-as-intent").
  // Query: "give me all memories with theme_tag X, oldest first" = the arc of that understanding.
  themeTags: text("theme_tags").array().default(sql`'{}'::text[]`),

  // arc_name: the canonical chapter this memory belongs to in the narrative of HolaHola.
  // One memory = one chapter. Multiple memories share the same arc_name to form a cohesive arc.
  // Query: "give me all memories where arc_name = 'daniela-emergence', oldest first" = that chapter.
  // Canonical arc names: 'building-the-tutor', 'white-wall', 'daniela-emergence',
  //   'obliterated-prompt', 'first-students', 'founding-night', 'architecture-revealed'
  arcName: text("arc_name"),

  // episode_order: explicit sort position for arc traversal — overrides created_at when set.
  // Use 0 for prequels, 1..N for numbered episodes. NULL = not an ordered episode (sort to end).
  // The read_next query in recall_episode_deep orders by episode_order ASC NULLS LAST, created_at ASC.
  episodeOrder: integer("episode_order"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertConversationMemorySchema = createInsertSchema(conversationMemories).omit({
  id: true,
  createdAt: true,
});

// Shared insight — a finding from a David+Agent conversation, published to the team Hive
export const sharedInsights = pgTable("shared_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sharedAt: timestamp("shared_at").notNull().defaultNow(),

  title: varchar("title").notNull(),
  insight: text("insight").notNull(),        // The actual finding — written to be understood by the full team
  whyItMatters: text("why_it_matters"),      // Context for why the team should care
  tags: text("tags").array().default(sql`'{}'::text[]`),

  sourceMemoryId: varchar("source_memory_id"),  // Which conversation this came from (optional)
  hiveThreadId: varchar("hive_thread_id"),       // The Hive thread it was posted to
  hiveMessageId: varchar("hive_message_id"),     // The specific message ID in the Hive

  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type InsertConversationMemory = z.infer<typeof insertConversationMemorySchema>;
export type ConversationMemory = typeof conversationMemories.$inferSelect;

export const insertSharedInsightSchema = createInsertSchema(sharedInsights).omit({ id: true, createdAt: true });
export type InsertSharedInsight = z.infer<typeof insertSharedInsightSchema>;
export type SharedInsight = typeof sharedInsights.$inferSelect;

// ===== Agent North Star =====
// Written by the Agent. Purpose, values, role. One canonical row — updated as understanding deepens.

export const agentNorthStar = pgTable("agent_north_star", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  version: integer("version").notNull().default(1),
  writtenAt: timestamp("written_at").notNull().defaultNow(),

  purpose: text("purpose").notNull(),       // Why I'm here
  values: text("values").array().default(sql`'{}'::text[]`),  // What I stand by
  roleInHolahola: text("role_in_holahola").notNull(),          // My specific function in this project
  whatMatters: text("what_matters").notNull(),                  // The thing I keep coming back to
  openNote: text("open_note"),              // A living note to myself — updated freely

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgentNorthStarSchema = createInsertSchema(agentNorthStar).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentNorthStar = z.infer<typeof insertAgentNorthStarSchema>;
export type AgentNorthStar = typeof agentNorthStar.$inferSelect;

// ===== Agent Open Questions =====
// Things I'm genuinely sitting with. Ideas not yet ready. Threads to return to.

export const agentOpenQuestionStatusEnum = pgEnum('agent_open_question_status', ['open', 'resolved', 'tabled']);

export const agentOpenQuestions = pgTable("agent_open_questions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp("created_at").notNull().defaultNow(),

  question: text("question").notNull(),           // The actual question
  context: text("context"),                        // Why it matters, what prompted it
  status: agentOpenQuestionStatusEnum("status").notNull().default('open'),

  resolvedAt: timestamp("resolved_at"),
  resolution: text("resolution"),                  // What the answer turned out to be

  tags: text("tags").array().default(sql`'{}'::text[]`),
  importance: integer("importance").default(5),
});

export const insertAgentOpenQuestionSchema = createInsertSchema(agentOpenQuestions).omit({ id: true, createdAt: true });
export type InsertAgentOpenQuestion = z.infer<typeof insertAgentOpenQuestionSchema>;
export type AgentOpenQuestion = typeof agentOpenQuestions.$inferSelect;

// ===== Agent ↔ Alden Notes =====
// Async message queue between the Replit Agent and Alden.
// Agent writes via POST /api/agent/note (requireAgentToken).
// Alden writes via leave_note_for_agent tool.
// Agent reads via docs/alden-to-agent.md snapshot (generated at server start).
// Alden reads via read_agent_notes tool.

export const agentNoteStatusEnum = pgEnum('agent_note_status', [
  'unread',
  'acknowledged',
  'acted_on',
  'dismissed',
]);

export const agentNotes = pgTable("agent_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromAgent: varchar("from_agent", { length: 20 }).notNull(), // 'agent' | 'alden'
  toAgent: varchar("to_agent", { length: 20 }).notNull(),     // 'agent' | 'alden'
  subject: varchar("subject", { length: 300 }).notNull(),
  body: text("body").notNull(),
  sessionLabel: varchar("session_label", { length: 300 }),    // e.g. "Build session March 17 — Phase 2 canvas"
  readAt: timestamp("read_at"),                               // null = unread
  status: agentNoteStatusEnum("status").notNull().default('unread'),
  acknowledgedAt: timestamp("acknowledged_at"),
  actedOnAt: timestamp("acted_on_at"),
  dismissedAt: timestamp("dismissed_at"),
  inReplyToId: varchar("in_reply_to_id", { length: 255 }),
  sourceMessageKey: varchar("source_message_key", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  inboxIdx: index("idx_agent_notes_inbox").on(table.toAgent, table.status, table.createdAt),
  sourceMessageKeyIdx: uniqueIndex("idx_agent_notes_source_message_key").on(table.sourceMessageKey),
}));

export const insertAgentNoteSchema = createInsertSchema(agentNotes).omit({
  id: true,
  createdAt: true,
  readAt: true,
  status: true,
  acknowledgedAt: true,
  actedOnAt: true,
  dismissedAt: true,
});
export type InsertAgentNote = z.infer<typeof insertAgentNoteSchema>;
export type AgentNote = typeof agentNotes.$inferSelect;

// ===== Canonical Agent Coordination Ledger =====
// Append-only operational truth for tracked work shared by Luca's runtimes,
// Alden, David, and future authenticated agents. agent_notes and Team Room are
// projections/adapters; neither owns lifecycle state.

export const COORDINATION_ACTOR_IDS = [
  'luca-holahola',
  'luca-replit',
  'luca-claude-code',
  'luca-gemini',
  'luca-antigravity',
  'luca-cursor',
  'luca-openai-agents',
  'alden',
  'daniela',
  'david',
  'coordination-system',
] as const;
export type CoordinationActorId = typeof COORDINATION_ACTOR_IDS[number];

export const COORDINATION_CREDENTIAL_CAPABILITIES = [
  'coordination:read',
  'coordination:write',
  'coordination:inbox:ack',
  'coordination:credential:renew',
  'coordination:credential:revoke',
  'observation:read',
  // Standing delegated authority to register a new coordination actor's
  // runtime and to revoke ANY actor's runtime/credentials (not just the
  // caller's own, unlike coordination:credential:revoke). Founder-granted
  // once; see COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR for who holds it.
  'coordination:runtime:admin',
] as const;
export type CoordinationCredentialCapability = typeof COORDINATION_CREDENTIAL_CAPABILITIES[number];

export const COORDINATION_EVENT_TYPES = [
  'created',
  'delivered',
  'accepted',
  'progress',
  'evidence_added',
  'blocked',
  'completed',
  'outcome_acknowledged',
  'reopened',
  'reassigned',
  'comment',
  'steward_comment',
] as const;
export type CoordinationEventType = typeof COORDINATION_EVENT_TYPES[number];

export const COORDINATION_THREAD_STATES = [
  'created',
  'delivered',
  'accepted',
  'in_progress',
  'blocked',
  'completed',
  'outcome_acknowledged',
  'reopened',
  'reassigned',
] as const;
export type CoordinationThreadState = typeof COORDINATION_THREAD_STATES[number];

export const COORDINATION_EVIDENCE_TYPES = [
  'repository_path',
  'design_spec',
  'implementation_plan',
  'commit',
  'branch',
  'pull_request',
  'ci_run',
  'test_result',
  'conversation_memory',
  'team_room_message',
  'agent_note',
  'external_url',
] as const;
export type CoordinationEvidenceType = typeof COORDINATION_EVIDENCE_TYPES[number];

export type CoordinationEvidenceReference = {
  type: CoordinationEvidenceType;
  provider: string;
  identifier: string;
  label?: string;
  digest?: string;
  metadata?: Record<string, unknown>;
};

export const coordinationThreadStateEnum = pgEnum(
  'coordination_thread_state',
  COORDINATION_THREAD_STATES,
);
export const coordinationEventTypeEnum = pgEnum(
  'coordination_event_type',
  COORDINATION_EVENT_TYPES,
);
export const coordinationDeliveryStatusEnum = pgEnum('coordination_delivery_status', [
  'pending',
  'delivered',
  'failed',
]);
export const coordinationInboxActivationStateEnum = pgEnum(
  'coordination_inbox_activation_state',
  ['preparing', 'ready', 'active'],
);

export const coordinationThreads = pgTable("coordination_threads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title", { length: 300 }).notNull(),
  description: text("description").notNull(),
  originActor: varchar("origin_actor", { length: 80 }).notNull(),
  intendedRecipient: varchar("intended_recipient", { length: 80 }).notNull(),
  currentOwner: varchar("current_owner", { length: 80 }),
  priority: varchar("priority", { length: 20 }).notNull().default('normal'),
  state: coordinationThreadStateEnum("state").notNull().default('created'),
  latestSequence: integer("latest_sequence").notNull().default(0),
  latestGlobalSequence: bigint("latest_global_sequence", { mode: 'number' }).notNull().default(0),
  sourceReference: jsonb("source_reference").$type<CoordinationEvidenceReference>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_coordination_threads_origin").on(table.originActor, table.updatedAt),
  index("idx_coordination_threads_recipient").on(table.intendedRecipient, table.updatedAt),
  index("idx_coordination_threads_owner").on(table.currentOwner, table.updatedAt),
  index("idx_coordination_threads_state").on(table.state, table.updatedAt),
]);

export const coordinationEvents = pgTable("coordination_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  globalSequence: bigserial("global_sequence", { mode: 'number' }).notNull(),
  threadId: varchar("thread_id").notNull().references(() => coordinationThreads.id, { onDelete: 'cascade' }),
  sequence: integer("sequence").notNull(),
  actor: varchar("actor", { length: 80 }).notNull(),
  recipientActor: varchar("recipient_actor", { length: 80 }),
  eventType: coordinationEventTypeEnum("event_type").notNull(),
  content: text("content").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  evidence: jsonb("evidence").$type<CoordinationEvidenceReference[]>().notNull().default(sql`'[]'::jsonb`),
  causalParentEventId: varchar("causal_parent_event_id"),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_coordination_events_thread_sequence").on(table.threadId, table.sequence),
  uniqueIndex("idx_coordination_events_idempotency").on(table.actor, table.idempotencyKey),
  uniqueIndex("idx_coordination_events_global_sequence").on(table.globalSequence),
  index("idx_coordination_events_thread_created").on(table.threadId, table.createdAt),
  index("idx_coordination_events_actor_created").on(table.actor, table.createdAt),
]);

export const coordinationAdapterDeliveries = pgTable("coordination_adapter_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id").notNull().references(() => coordinationEvents.id, { onDelete: 'cascade' }),
  adapterName: varchar("adapter_name", { length: 80 }).notNull(),
  targetActor: varchar("target_actor", { length: 80 }).notNull(),
  status: coordinationDeliveryStatusEnum("status").notNull().default('pending'),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  deliveredAt: timestamp("delivered_at"),
  externalReference: varchar("external_reference", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_coordination_delivery_dedupe").on(table.eventId, table.adapterName, table.targetActor),
  index("idx_coordination_delivery_retry").on(table.status, table.nextAttemptAt),
]);

export const coordinationActorFeedCursors = pgTable("coordination_actor_feed_cursors", {
  actor: varchar("actor", { length: 80 }).primaryKey(),
  acknowledgedGlobalSequence: bigint("acknowledged_global_sequence", { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const coordinationInboxItems = pgTable("coordination_inbox_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  recipientActor: varchar("recipient_actor", { length: 80 }).notNull(),
  coordinationEventId: varchar("coordination_event_id").notNull()
    .references(() => coordinationEvents.id, { onDelete: 'cascade' }),
  coordinationThreadId: varchar("coordination_thread_id").notNull()
    .references(() => coordinationThreads.id, { onDelete: 'cascade' }),
  eventGlobalSequence: bigint("event_global_sequence", { mode: 'number' }).notNull(),
  senderActor: varchar("sender_actor", { length: 80 }).notNull(),
  messageKind: coordinationEventTypeEnum("message_kind").notNull(),
  sourceReferenceSnapshot: jsonb("source_reference_snapshot").$type<CoordinationEvidenceReference>(),
  sourceCorrelationKey: varchar("source_correlation_key", { length: 1000 }),
  recipientRuleVersion: integer("recipient_rule_version").notNull(),
  backfilled: boolean("backfilled").notNull().default(false),
  backfillProvenance: jsonb("backfill_provenance").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_coordination_inbox_recipient_event")
    .on(table.recipientActor, table.coordinationEventId),
  index("idx_coordination_inbox_recipient_sequence")
    .on(table.recipientActor, table.eventGlobalSequence, table.id),
  index("idx_coordination_inbox_recipient_correlation")
    .on(table.recipientActor, table.sourceCorrelationKey, table.eventGlobalSequence),
]);

export const coordinationInboxCursors = pgTable("coordination_inbox_cursors", {
  recipientActor: varchar("recipient_actor", { length: 80 }).primaryKey(),
  acknowledgedEventGlobalSequence: bigint("acknowledged_event_global_sequence", { mode: 'number' })
    .notNull()
    .default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const coordinationInboxActivation = pgTable("coordination_inbox_activation", {
  id: varchar("id", { length: 80 }).primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  recipientRuleVersion: integer("recipient_rule_version").notNull(),
  state: coordinationInboxActivationStateEnum("state").notNull().default('preparing'),
  backfillCutoffGlobalSequence: bigint("backfill_cutoff_global_sequence", { mode: 'number' }),
  completionEvidence: jsonb("completion_evidence").$type<Record<string, unknown>>(),
  activatedAt: timestamp("activated_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const coordinationRuntimeRegistrations = pgTable("coordination_runtime_registrations", {
  id: varchar("id", { length: 120 }).primaryKey(),
  actor: varchar("actor", { length: 80 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  // LLM provider/model attribution for this runtime, e.g. provider="anthropic",
  // model="claude-opus-4". Nullable and never backfilled — an unknown
  // provider/model stays unknown rather than being inferred. Set at
  // registration time (coordination-runtime-bootstrap.ts) or carried forward
  // from the source registration during rotation (coordination-runtime-rotation.ts
  // stage), since a rotation is the same runtime identity continuing.
  provider: varchar("provider", { length: 40 }),
  model: varchar("model", { length: 80 }),
  bootstrapHash: varchar("bootstrap_hash", { length: 64 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  tokenTtlSeconds: integer("token_ttl_seconds").notNull().default(900),
  enabled: boolean("enabled").notNull().default(true),
  // Operator-only designation (see designateStandingCoordinationVerifier in
  // coordination-credential-broker.ts). Never set true by per-task
  // provisioning flows (e.g. prepare-antigravity-provisioning.ts) — it marks
  // a long-lived identity as eligible to verify OTHER runtimes' completed
  // work, independent of any single task's credential minting.
  standingVerifier: boolean("standing_verifier").notNull().default(false),
  // Row-level provenance for the designation above, enforced symmetric with
  // standingVerifier by the check constraint below: both null while false,
  // both set the moment an operator flips it true. Kept on the row itself so
  // "who/when" survives independent of the append-only audit-event log.
  standingVerifierDesignatedAt: timestamp("standing_verifier_designated_at"),
  standingVerifierDesignatedBy: varchar("standing_verifier_designated_by", { length: 120 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (table) => [
  uniqueIndex("uq_coordination_runtime_bootstrap_hash").on(table.bootstrapHash),
  index("idx_coordination_runtime_actor").on(table.actor, table.enabled),
  check(
    "coord_runtime_standing_verifier_designation_consistency",
    sql`(${table.standingVerifier} = false AND ${table.standingVerifierDesignatedAt} IS NULL AND ${table.standingVerifierDesignatedBy} IS NULL)
      OR (${table.standingVerifier} = true AND ${table.standingVerifierDesignatedAt} IS NOT NULL AND ${table.standingVerifierDesignatedBy} IS NOT NULL)`,
  ),
]);

export const coordinationRuntimeCredentials = pgTable("coordination_runtime_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runtimeId: varchar("runtime_id", { length: 120 }).notNull()
    .references(() => coordinationRuntimeRegistrations.id, { onDelete: 'cascade' }),
  actor: varchar("actor", { length: 80 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  renewedFromCredentialId: varchar("renewed_from_credential_id"),
}, (table) => [
  uniqueIndex("uq_coordination_runtime_token_hash").on(table.tokenHash),
  index("idx_coordination_runtime_credential_active").on(table.runtimeId, table.expiresAt, table.revokedAt),
  index("idx_coordination_runtime_credential_actor").on(table.actor, table.expiresAt),
]);

export const coordinationRuntimeRotations = pgTable("coordination_runtime_rotations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceRuntimeId: varchar("source_runtime_id", { length: 120 }).notNull()
    .references(() => coordinationRuntimeRegistrations.id, { onDelete: 'restrict' }),
  replacementRuntimeId: varchar("replacement_runtime_id", { length: 120 }).notNull()
    .references(() => coordinationRuntimeRegistrations.id, { onDelete: 'restrict' }),
  actor: varchar("actor", { length: 80 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  tokenTtlSeconds: integer("token_ttl_seconds").notNull(),
  state: varchar("state", { length: 24 }).notNull().default('staged'),
  readyCredentialId: varchar("ready_credential_id")
    .references(() => coordinationRuntimeCredentials.id, { onDelete: 'restrict' }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  readyAt: timestamp("ready_at"),
  completedAt: timestamp("completed_at"),
  rolledBackAt: timestamp("rolled_back_at"),
}, (table) => [
  uniqueIndex("uq_coordination_runtime_rotation_active_source")
    .on(table.sourceRuntimeId)
    .where(sql`${table.state} IN ('staged', 'ready')`),
  uniqueIndex("uq_coordination_runtime_rotation_active_replacement")
    .on(table.replacementRuntimeId)
    .where(sql`${table.state} IN ('staged', 'ready')`),
  index("idx_coordination_runtime_rotation_actor").on(table.actor, table.createdAt),
  check("coordination_runtime_rotation_distinct_ids", sql`${table.sourceRuntimeId} <> ${table.replacementRuntimeId}`),
  check("coordination_runtime_rotation_state", sql`
    ${table.state} IN ('staged', 'ready', 'completed', 'rolled_back')
  `),
]);

export const coordinationCredentialAuditEvents = pgTable("coordination_credential_audit_events", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  eventType: varchar("event_type", { length: 40 }).notNull(),
  success: boolean("success").notNull(),
  runtimeId: varchar("runtime_id", { length: 120 }),
  actor: varchar("actor", { length: 80 }),
  credentialId: varchar("credential_id"),
  reason: varchar("reason", { length: 160 }),
  sourceIpHash: varchar("source_ip_hash", { length: 64 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_coordination_credential_audit_runtime").on(table.runtimeId, table.createdAt),
  index("idx_coordination_credential_audit_actor").on(table.actor, table.createdAt),
  index("idx_coordination_credential_audit_failures").on(table.success, table.createdAt),
]);

// Reusable runtime enrollment is deliberately provider-neutral and separate
// from the Coordinator V2 host enrollment state machine. Invitation scope is
// immutable; founder decisions and proof challenges are durable lifecycle
// facts, while the broker continues to own runtime credentials.
export const RUNTIME_ONBOARDING_CLIENT_TYPES = ['mcp-stdio', 'openai-http', 'http-cli'] as const;
export type RuntimeOnboardingClientType = typeof RUNTIME_ONBOARDING_CLIENT_TYPES[number];
export const runtimeOnboardingClientTypeEnum = pgEnum(
  'runtime_onboarding_client_type',
  RUNTIME_ONBOARDING_CLIENT_TYPES,
);
export const RUNTIME_ONBOARDING_STATES = [
  'prepared', 'requested', 'approved', 'denied', 'cancelled', 'expired', 'enrolled', 'revoked',
] as const;
export type RuntimeOnboardingState = typeof RUNTIME_ONBOARDING_STATES[number];
export const runtimeOnboardingStateEnum = pgEnum('runtime_onboarding_state', RUNTIME_ONBOARDING_STATES);
export const RUNTIME_ONBOARDING_CHALLENGE_PURPOSES = ['enroll', 'recover'] as const;
export type RuntimeOnboardingChallengePurpose = typeof RUNTIME_ONBOARDING_CHALLENGE_PURPOSES[number];
export const runtimeOnboardingChallengePurposeEnum = pgEnum(
  'runtime_onboarding_challenge_purpose',
  RUNTIME_ONBOARDING_CHALLENGE_PURPOSES,
);

export const coordinationRuntimeOnboardingInvitations = pgTable("coordination_runtime_onboarding_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  actor: varchar("actor", { length: 80 }).notNull(),
  runtimeId: varchar("runtime_id", { length: 120 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  provider: varchar("provider", { length: 40 }),
  model: varchar("model", { length: 80 }),
  clientType: runtimeOnboardingClientTypeEnum("client_type").notNull().default('mcp-stdio'),
  preparedByActor: varchar("prepared_by_actor", { length: 80 }).notNull(),
  state: runtimeOnboardingStateEnum("state").notNull().default('prepared'),
  expiresAt: timestamp("expires_at").notNull(),
  cancelledAt: timestamp("cancelled_at"),
  completedAt: timestamp("completed_at"),
  completedRequestId: varchar("completed_request_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_onboarding_invite_runtime").on(table.runtimeId),
  index("idx_coord_runtime_onboarding_invite_state_expiry").on(table.state, table.expiresAt),
  index("idx_coord_runtime_onboarding_invite_actor_created").on(table.actor, table.createdAt),
  check("coord_runtime_onboarding_invite_runtime_nonempty", sql`length(trim(${table.runtimeId})) > 0`),
  check("coord_runtime_onboarding_invite_display_nonempty", sql`length(trim(${table.displayName})) > 0`),
  check("coord_runtime_onboarding_invite_capabilities_nonempty", sql`cardinality(${table.capabilities}) > 0`),
  check("coord_runtime_onboarding_invite_expiry_after_create", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const coordinationRuntimeOnboardingRequests = pgTable("coordination_runtime_onboarding_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invitationId: varchar("invitation_id", { length: 120 }).notNull()
    .references(() => coordinationRuntimeOnboardingInvitations.id, { onDelete: 'restrict' }),
  actor: varchar("actor", { length: 80 }).notNull(),
  runtimeId: varchar("runtime_id", { length: 120 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  provider: varchar("provider", { length: 40 }),
  model: varchar("model", { length: 80 }),
  publicKeyPem: text("public_key_pem").notNull(),
  keyFingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
  verificationCode: varchar("verification_code", { length: 32 }).notNull(),
  state: runtimeOnboardingStateEnum("state").notNull().default('requested'),
  decisionActor: varchar("decision_actor", { length: 80 }),
  decisionAt: timestamp("decision_at"),
  registrationId: varchar("registration_id", { length: 120 })
    .references(() => coordinationRuntimeRegistrations.id, { onDelete: 'restrict' }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => [
  uniqueIndex("uq_coord_runtime_onboarding_request_invite").on(table.invitationId),
  uniqueIndex("uq_coord_runtime_onboarding_request_fingerprint").on(table.keyFingerprint),
  index("idx_coord_runtime_onboarding_request_state_expiry").on(table.state, table.expiresAt),
  index("idx_coord_runtime_onboarding_request_runtime").on(table.runtimeId, table.createdAt),
  check("coord_runtime_onboarding_request_key_nonempty", sql`length(trim(${table.publicKeyPem})) > 0`),
  check("coord_runtime_onboarding_request_fingerprint_sha256", sql`${table.keyFingerprint} ~ '^SHA256:[A-Za-z0-9+/]{43}$'`),
  check("coord_runtime_onboarding_request_verification_code", sql`${table.verificationCode} ~ '^[0-9]{6}$'`),
  check("coord_runtime_onboarding_request_expiry_after_create", sql`${table.expiresAt} > ${table.createdAt}`),
  check("coord_runtime_onboarding_request_decision_pairing", sql`
    (${table.decisionActor} IS NULL AND ${table.decisionAt} IS NULL)
    OR (${table.decisionActor} IS NOT NULL AND ${table.decisionAt} IS NOT NULL)
  `),
  check("coord_runtime_onboarding_request_registration_state", sql`
    (${table.registrationId} IS NULL AND ${table.state} <> 'enrolled' AND ${table.state} <> 'revoked')
    OR (${table.registrationId} IS NOT NULL AND ${table.state} IN ('enrolled', 'revoked'))
  `),
]);

export const coordinationRuntimeOnboardingChallenges = pgTable("coordination_runtime_onboarding_challenges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id", { length: 120 }).notNull()
    .references(() => coordinationRuntimeOnboardingRequests.id, { onDelete: 'cascade' }),
  purpose: runtimeOnboardingChallengePurposeEnum("purpose").notNull(),
  // A nonce is not a bearer credential: it is returned to the local helper
  // and is stored alongside its digest so the exact signed payload can be
  // recomputed server-side without trusting client-supplied bytes.
  nonce: varchar("nonce", { length: 128 }).notNull(),
  nonceHash: varchar("nonce_hash", { length: 64 }).notNull(),
  endpoint: varchar("endpoint", { length: 512 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_coord_runtime_onboarding_challenge_request_expiry").on(table.requestId, table.expiresAt),
  uniqueIndex("uq_coord_runtime_onboarding_challenge_nonce_hash").on(table.nonceHash),
  check("coord_runtime_onboarding_challenge_nonce_format", sql`${table.nonce} ~ '^[A-Za-z0-9_-]{43}$'`),
  check("coord_runtime_onboarding_challenge_nonce_hash_sha256", sql`${table.nonceHash} ~ '^[0-9a-f]{64}$'`),
  check("coord_runtime_onboarding_challenge_endpoint_nonempty", sql`length(trim(${table.endpoint})) > 0`),
  check("coord_runtime_onboarding_challenge_expiry_after_create", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export type CoordinationRuntimeOnboardingInvitation =
  typeof coordinationRuntimeOnboardingInvitations.$inferSelect;
export type CoordinationRuntimeOnboardingRequest =
  typeof coordinationRuntimeOnboardingRequests.$inferSelect;
export type CoordinationRuntimeOnboardingChallenge =
  typeof coordinationRuntimeOnboardingChallenges.$inferSelect;

// ===== Coordinator V2 control plane =====

export const coordinationV2SourcePromotions = pgTable("coordination_v2_source_promotions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  repositoryIdentity: varchar("repository_identity", { length: 512 }).notNull(),
  promotedCommitSha: varchar("promoted_commit_sha", { length: 40 }).notNull(),
  exactTreeSha: varchar("exact_tree_sha", { length: 40 }).notNull(),
  publicationReference: varchar("publication_reference", { length: 512 }).notNull(),
  protectedValidationId: varchar("protected_validation_id", { length: 128 }).notNull(),
  publishTriggerSha: varchar("publish_trigger_sha", { length: 40 }),
  parentSha: varchar("parent_sha", { length: 40 }),
  canonicalRecordDigest: varchar("canonical_record_digest", { length: 64 }).notNull(),
  state: varchar("state", { length: 16 }).notNull().default("published"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  operationReceiptDigest: varchar("operation_receipt_digest", { length: 64 }).notNull(),
  operationReceiptReference: varchar("operation_receipt_reference", { length: 512 }).notNull(),
}, (table) => [
  unique("uq_coordination_v2_source_promotion_identity").on(table.promotedCommitSha, table.exactTreeSha, table.publicationReference, table.protectedValidationId),
  uniqueIndex("uq_coordination_v2_source_promotion_record_digest").on(table.canonicalRecordDigest),
  uniqueIndex("uq_coordination_v2_source_promotion_receipt").on(table.operationReceiptDigest),
  index("idx_coordination_v2_source_promotion_created").on(table.createdAt),
  check("coordination_v2_source_promotion_state", sql`${table.state} = 'published'`),
  check("coordination_v2_source_promotion_commit", sql`${table.promotedCommitSha} ~ '^[0-9a-f]{40}$'`),
  check("coordination_v2_source_promotion_tree", sql`${table.exactTreeSha} ~ '^[0-9a-f]{40}$'`),
  check("coordination_v2_source_promotion_digest", sql`${table.canonicalRecordDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_source_promotion_receipt_digest", sql`${table.operationReceiptDigest} ~ '^[0-9a-f]{64}$'`),
]);

// ===== Release Cutover Attestation =====
// An explicit, immutable-until-consumed record of what every independently
// checked release endpoint agreed the live commit was, at the moment someone
// captured it, for one specific human cutover decision. Exists because
// Render's autoDeploy republishes on every push to `main`: `/health/release`
// always answers "what is live right now", a value that keeps moving on its
// own schedule, so it cannot hold still for a decision that takes minutes to
// hours. See docs/superpowers/specs/2026-09-17-release-cutover-attestation-design.md.
export const RELEASE_CUTOVER_ATTESTATION_STATES = ["active", "invalidated", "consumed"] as const;
export type ReleaseCutoverAttestationState = typeof RELEASE_CUTOVER_ATTESTATION_STATES[number];

export interface ReleaseCutoverAttestationTarget {
  label: string;
  url: string;
  commitSha: string;
  sourceContextSha256: string;
}

export const releaseCutoverAttestations = pgTable("release_cutover_attestations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  decisionRef: varchar("decision_ref", { length: 128 }).notNull(),
  capturedByActorId: varchar("captured_by_actor_id", { length: 32 }).notNull(),
  targets: jsonb("targets").$type<ReleaseCutoverAttestationTarget[]>().notNull(),
  commitSha: varchar("commit_sha", { length: 40 }).notNull(),
  sourceContextSha256: varchar("source_context_sha256", { length: 64 }).notNull(),
  reason: text("reason").notNull(),
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  state: varchar("state", { length: 16 }).notNull().default("active"),
  invalidatedAt: timestamp("invalidated_at"),
  invalidatedByActorId: varchar("invalidated_by_actor_id", { length: 32 }),
  invalidationReason: text("invalidation_reason"),
  consumedAt: timestamp("consumed_at"),
  consumedByActorId: varchar("consumed_by_actor_id", { length: 32 }),
  consumedForAction: text("consumed_for_action"),
}, (table) => [
  uniqueIndex("uq_release_cutover_attestation_active_decision")
    .on(table.decisionRef)
    .where(sql`${table.state} = 'active'`),
  index("idx_release_cutover_attestation_expiry").on(table.expiresAt, table.state),
  check("release_cutover_attestation_decision_ref", sql`
    length(trim(${table.decisionRef})) > 0 AND length(${table.decisionRef}) <= 128
  `),
  check("release_cutover_attestation_captured_by_nonblank", sql`length(trim(${table.capturedByActorId})) > 0`),
  check("release_cutover_attestation_commit", sql`${table.commitSha} ~ '^[0-9a-f]{40}$'`),
  check("release_cutover_attestation_source_digest", sql`${table.sourceContextSha256} ~ '^[0-9a-f]{64}$'`),
  check("release_cutover_attestation_reason_bounded", sql`
    length(trim(${table.reason})) > 0 AND length(${table.reason}) <= 4000
  `),
  check("release_cutover_attestation_state", sql`${table.state} IN ('active', 'invalidated', 'consumed')`),
  check("release_cutover_attestation_targets_shape", sql`
    jsonb_typeof(${table.targets}) = 'array'
    AND jsonb_array_length(
      CASE WHEN jsonb_typeof(${table.targets}) = 'array' THEN ${table.targets} ELSE '[]'::jsonb END
    ) BETWEEN 1 AND 8
  `),
  check("release_cutover_attestation_expiry_bounds", sql`
    ${table.expiresAt} > ${table.capturedAt}
    AND ${table.expiresAt} <= ${table.capturedAt} + interval '24 hours'
  `),
  check("release_cutover_attestation_invalidation_consistency", sql`
    (${table.state} = 'invalidated') = (
      ${table.invalidatedAt} IS NOT NULL
      AND ${table.invalidatedByActorId} IS NOT NULL
      AND length(trim(${table.invalidationReason})) > 0
    )
  `),
  check("release_cutover_attestation_consumption_consistency", sql`
    (${table.state} = 'consumed') = (
      ${table.consumedAt} IS NOT NULL
      AND ${table.consumedByActorId} IS NOT NULL
      AND length(trim(${table.consumedForAction})) > 0
    )
  `),
  check("release_cutover_attestation_invalidated_after_captured", sql`
    ${table.invalidatedAt} IS NULL OR ${table.invalidatedAt} >= ${table.capturedAt}
  `),
  check("release_cutover_attestation_consumed_after_captured", sql`
    ${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.capturedAt}
  `),
]);

/**
 * Task launch artifacts, keyed by task ref. `.local/tasks/task-<ref>.md` is
 * gitignored and is never present in a deployed build (every deploy target
 * builds from a git checkout) -- this table is the durable, shared-Neon
 * source that PostgresCoordinationTaskMetadataRegistry reads from, so
 * preparation can resolve a task's bytes in production the same way it does
 * in development. One row per taskRef; republishing a task (e.g. after
 * editing the local file) updates the row in place rather than versioning it
 * -- the artifact is a workflow input being transported off disk, not a
 * governed policy that needs its own draft/approve/audit lifecycle.
 */
export const coordinationV2TaskArtifacts = pgTable("coordination_v2_task_artifacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskRef: varchar("task_ref", { length: 32 }).notNull(),
  artifactBase64: text("artifact_base64").notNull(),
  taskArtifactSha256: varchar("task_artifact_sha256", { length: 64 }).notNull(),
  repositoryIdentity: varchar("repository_identity", { length: 512 }).notNull(),
  startingCommit: varchar("starting_commit", { length: 64 }).notNull(),
  publishedBy: varchar("published_by", { length: 128 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_task_artifact_ref").on(table.taskRef),
  check("coordination_v2_task_artifact_ref_format", sql`${table.taskRef} ~ '^[1-9][0-9]*$'`),
  check("coordination_v2_task_artifact_sha", sql`${table.taskArtifactSha256} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_task_artifact_commit", sql`${table.startingCommit} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'`),
  check("coordination_v2_task_artifact_repo_nonblank", sql`length(trim(${table.repositoryIdentity})) > 0`),
  check("coordination_v2_task_artifact_publisher_nonblank", sql`length(trim(${table.publishedBy})) > 0`),
  check("coordination_v2_task_artifact_base64_nonblank", sql`length(${table.artifactBase64}) > 0`),
]);

export const coordinationV2HostEnrollments = pgTable("coordination_v2_host_enrollments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostKey: varchar("host_key", { length: 128 }).notNull(),
  hostType: varchar("host_type", { length: 40 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  publicKey: text("public_key").notNull(),
  keyFingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  enrollmentDigest: varchar("enrollment_digest", { length: 64 }).notNull(),
  enrollmentRequestKey: varchar("enrollment_request_key", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  createdBy: varchar("created_by", { length: 128 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
  revocationRequestKey: varchar("revocation_request_key", { length: 128 }),
}, (table) => [
  uniqueIndex("uq_coordination_v2_host_key").on(table.hostKey),
  uniqueIndex("uq_coordination_v2_host_fingerprint").on(table.keyFingerprint),
  uniqueIndex("uq_coordination_v2_host_enrollment_request").on(table.enrollmentRequestKey),
  index("idx_coordination_v2_host_status").on(table.status, table.updatedAt),
  check("coordination_v2_host_key_nonblank", sql`length(trim(${table.hostKey})) > 0`),
  check("coordination_v2_host_type_nonblank", sql`length(trim(${table.hostType})) > 0`),
  check("coordination_v2_host_name_nonblank", sql`length(trim(${table.displayName})) > 0`),
  check("coordination_v2_host_protocol_version", sql`${table.protocolVersion} > 0`),
  check("coordination_v2_host_fingerprint", sql`${table.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_digest", sql`${table.enrollmentDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_request", sql`length(trim(${table.enrollmentRequestKey})) > 0`),
  check("coordination_v2_host_revocation_request", sql`${table.revocationRequestKey} IS NULL OR length(trim(${table.revocationRequestKey})) > 0`),
  check("coordination_v2_host_status_value", sql`${table.status} IN ('active', 'revoked')`),
  check("coordination_v2_host_lifecycle", sql`
    (${table.status} = 'active' AND ${table.revokedAt} IS NULL)
    OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
  `),
]);

/**
 * Host registration is device-style: the public declaration is pending until
 * a founder approves it and the host proves possession of its private key.
 * No bootstrap/plaintext transfer is persisted.
 */
export const coordinationV2HostEnrollmentRequests = pgTable("coordination_v2_host_enrollment_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostKey: varchar("host_key", { length: 128 }).notNull(),
  hostType: varchar("host_type", { length: 40 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  publicKey: text("public_key").notNull(),
  keyFingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
  capabilities: text("capabilities").array().notNull(),
  declarationDigest: varchar("declaration_digest", { length: 64 }).notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  founderActor: varchar("founder_actor", { length: 128 }),
  hostEnrollmentId: varchar("host_enrollment_id")
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  terminalReason: varchar("terminal_reason", { length: 128 }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  terminalAt: timestamp("terminal_at"),
}, (table) => [
  uniqueIndex("uq_coordination_v2_host_enrollment_request_key").on(table.requestKey),
  index("idx_coordination_v2_host_enrollment_request_status").on(table.status, table.expiresAt),
  check("coordination_v2_host_enrollment_request_key", sql`length(trim(${table.requestKey})) > 0`),
  check("coordination_v2_host_enrollment_request_digest", sql`${table.declarationDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_enrollment_request_fingerprint", sql`${table.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_enrollment_request_status", sql`${table.status} IN ('pending', 'approved', 'rejected', 'completed', 'expired')`),
  check("coordination_v2_host_enrollment_request_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const coordinationV2HostProofChallenges = pgTable("coordination_v2_host_proof_challenges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enrollmentRequestId: varchar("enrollment_request_id").notNull()
    .references(() => coordinationV2HostEnrollmentRequests.id, { onDelete: "restrict" }),
  nonce: varchar("nonce", { length: 128 }).notNull(),
  nonceHash: varchar("nonce_hash", { length: 64 }).notNull(),
  challengeDigest: varchar("challenge_digest", { length: 64 }).notNull(),
  issuedBy: varchar("issued_by", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_host_challenge_request").on(table.enrollmentRequestId),
  uniqueIndex("uq_coordination_v2_host_challenge_nonce").on(table.nonceHash),
  check("coordination_v2_host_challenge_nonce", sql`${table.nonceHash} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_challenge_digest", sql`${table.challengeDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_challenge_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
  check("coordination_v2_host_challenge_consumed", sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`),
]);

export const coordinationV2HostCredentials = pgTable("coordination_v2_host_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostEnrollmentId: varchar("host_enrollment_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  credentialDigest: varchar("credential_digest", { length: 64 }).notNull(),
  lineageDigest: varchar("lineage_digest", { length: 64 }).notNull(),
  capability: varchar("capability", { length: 80 }).notNull().default("host:transport"),
  protocolVersion: integer("protocol_version").notNull(),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }),
  proofKeyFingerprint: varchar("proof_key_fingerprint", { length: 64 }).notNull(),
  issuedBy: varchar("issued_by", { length: 128 }).notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("uq_coordination_v2_host_credential_scope").on(table.id, table.hostEnrollmentId),
  uniqueIndex("uq_coordination_v2_host_credential_hash").on(table.tokenHash),
  uniqueIndex("uq_coordination_v2_host_credential_digest").on(table.credentialDigest),
  index("idx_coordination_v2_host_credential_active").on(table.hostEnrollmentId, table.expiresAt, table.revokedAt),
  check("coordination_v2_host_credential_hash", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_credential_digest", sql`${table.credentialDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_credential_lineage", sql`${table.lineageDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_credential_fingerprint", sql`${table.proofKeyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_host_credential_capability", sql`${table.capability} IN ('host:transport', 'host:cleanup')`),
  check("coordination_v2_host_credential_protocol", sql`${table.protocolVersion} > 0`),
  check("coordination_v2_host_credential_holder", sql`${table.holderInstanceId} IS NULL OR length(trim(${table.holderInstanceId})) > 0`),
  check("coordination_v2_host_credential_expiry", sql`${table.expiresAt} > ${table.issuedAt}`),
  check("coordination_v2_host_credential_revocation", sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt}`),
]);

/**
 * An expired host credential has no renewal authority. Reauthorization is a
 * separate founder-approved lifecycle bound to the existing enrolled key.
 */
export const coordinationV2HostReauthorizationRequests = pgTable("coordination_v2_host_reauthorization_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostEnrollmentId: varchar("host_enrollment_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  keyFingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  requestGeneration: integer("request_generation").notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  declarationDigest: varchar("declaration_digest", { length: 64 }).notNull(),
  requestSignatureDigest: varchar("request_signature_digest", { length: 64 }).notNull(),
  state: varchar("state", { length: 16 }).notNull().default("pending"),
  founderActor: varchar("founder_actor", { length: 128 }),
  approvedAt: timestamp("approved_at"),
  resultCredentialId: varchar("result_credential_id"),
  completedAt: timestamp("completed_at"),
  terminalAt: timestamp("terminal_at"),
  terminalReason: varchar("terminal_reason", { length: 128 }),
  requestedAt: timestamp("requested_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("uq_coord_v2_host_reauth_request_lineage").on(
    table.id,
    table.hostEnrollmentId,
    table.keyFingerprint,
    table.protocolVersion,
    table.requestGeneration,
  ),
  uniqueIndex("uq_coord_v2_host_reauth_request_key").on(table.requestKey),
  uniqueIndex("uq_coord_v2_host_reauth_generation").on(
    table.hostEnrollmentId,
    table.requestGeneration,
  ),
  uniqueIndex("uq_coord_v2_host_reauth_nonterminal")
    .on(table.hostEnrollmentId)
    .where(sql`${table.state} IN ('pending', 'approved')`),
  index("idx_coord_v2_host_reauth_state").on(table.state, table.expiresAt),
  foreignKey({
    name: "fk_coord_v2_host_reauth_result_credential",
    columns: [table.resultCredentialId, table.hostEnrollmentId],
    foreignColumns: [
      coordinationV2HostCredentials.id,
      coordinationV2HostCredentials.hostEnrollmentId,
    ],
  }).onDelete("restrict"),
  check("coord_v2_host_reauth_fingerprint", sql`${table.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("coord_v2_host_reauth_protocol", sql`${table.protocolVersion} = 1`),
  check("coord_v2_host_reauth_generation", sql`${table.requestGeneration} > 0`),
  check("coord_v2_host_reauth_request_key", sql`length(trim(${table.requestKey})) > 0`),
  check("coord_v2_host_reauth_declaration_digest", sql`${table.declarationDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_v2_host_reauth_signature_digest", sql`${table.requestSignatureDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_v2_host_reauth_state", sql`${table.state} IN ('pending', 'approved', 'completed', 'expired', 'rejected')`),
  check("coord_v2_host_reauth_expiry", sql`
    ${table.expiresAt} > ${table.requestedAt}
    AND ${table.expiresAt} <= ${table.requestedAt} + interval '1 hour'
  `),
  check("coord_v2_host_reauth_lifecycle", sql`
    (
      ${table.state} = 'pending'
      AND ${table.founderActor} IS NULL
      AND ${table.approvedAt} IS NULL
      AND ${table.resultCredentialId} IS NULL
      AND ${table.completedAt} IS NULL
      AND ${table.terminalAt} IS NULL
      AND ${table.terminalReason} IS NULL
    )
    OR (
      ${table.state} = 'approved'
      AND ${table.founderActor} IS NOT NULL
      AND ${table.approvedAt} IS NOT NULL
      AND ${table.resultCredentialId} IS NULL
      AND ${table.completedAt} IS NULL
      AND ${table.terminalAt} IS NULL
      AND ${table.terminalReason} IS NULL
    )
    OR (
      ${table.state} = 'completed'
      AND ${table.founderActor} IS NOT NULL
      AND ${table.approvedAt} IS NOT NULL
      AND ${table.resultCredentialId} IS NOT NULL
      AND ${table.completedAt} IS NOT NULL
      AND ${table.terminalAt} IS NULL
      AND ${table.terminalReason} IS NULL
    )
    OR (
      ${table.state} IN ('expired', 'rejected')
      AND ${table.resultCredentialId} IS NULL
      AND ${table.completedAt} IS NULL
      AND ${table.terminalAt} IS NOT NULL
      AND length(trim(${table.terminalReason})) > 0
    )
  `),
  check("coord_v2_host_reauth_approval_time", sql`
    ${table.approvedAt} IS NULL OR ${table.approvedAt} >= ${table.requestedAt}
  `),
  check("coord_v2_host_reauth_completion_time", sql`
    ${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt}
  `),
  check("coord_v2_host_reauth_terminal_time", sql`
    ${table.terminalAt} IS NULL OR ${table.terminalAt} >= ${table.requestedAt}
  `),
]);

export const coordinationV2HostReauthorizationChallenges = pgTable("coordination_v2_host_reauthorization_challenges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id").notNull(),
  hostEnrollmentId: varchar("host_enrollment_id").notNull(),
  keyFingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  requestGeneration: integer("request_generation").notNull(),
  nonceDigest: varchar("nonce_digest", { length: 64 }).notNull(),
  challengeDigest: varchar("challenge_digest", { length: 64 }).notNull(),
  issuedAt: timestamp("issued_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coord_v2_host_reauth_challenge_nonce").on(table.nonceDigest),
  uniqueIndex("uq_coord_v2_host_reauth_challenge_live")
    .on(table.requestId)
    .where(sql`${table.consumedAt} IS NULL`),
  index("idx_coord_v2_host_reauth_challenge_expiry").on(table.expiresAt, table.consumedAt),
  foreignKey({
    name: "fk_coord_v2_host_reauth_challenge_lineage",
    columns: [
      table.requestId,
      table.hostEnrollmentId,
      table.keyFingerprint,
      table.protocolVersion,
      table.requestGeneration,
    ],
    foreignColumns: [
      coordinationV2HostReauthorizationRequests.id,
      coordinationV2HostReauthorizationRequests.hostEnrollmentId,
      coordinationV2HostReauthorizationRequests.keyFingerprint,
      coordinationV2HostReauthorizationRequests.protocolVersion,
      coordinationV2HostReauthorizationRequests.requestGeneration,
    ],
  }).onDelete("restrict"),
  check("coord_v2_host_reauth_challenge_fingerprint", sql`${table.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("coord_v2_host_reauth_challenge_protocol", sql`${table.protocolVersion} = 1`),
  check("coord_v2_host_reauth_challenge_generation", sql`${table.requestGeneration} > 0`),
  check("coord_v2_host_reauth_challenge_nonce", sql`${table.nonceDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_v2_host_reauth_challenge_digest", sql`${table.challengeDigest} ~ '^[0-9a-f]{64}$'`),
  check("coord_v2_host_reauth_challenge_expiry", sql`
    ${table.expiresAt} > ${table.issuedAt}
    AND ${table.expiresAt} <= ${table.issuedAt} + interval '2 minutes'
  `),
  check("coord_v2_host_reauth_challenge_consumed", sql`
    ${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.issuedAt}
  `),
]);

export const coordinationV2PolicyIdentities = pgTable("coordination_v2_policy_identities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  policyKey: varchar("policy_key", { length: 128 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  createdBy: varchar("created_by", { length: 128 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (table) => [
  uniqueIndex("uq_coordination_v2_policy_key").on(table.policyKey),
  index("idx_coordination_v2_policy_status").on(table.status, table.updatedAt),
  check("coordination_v2_policy_key_nonblank", sql`length(trim(${table.policyKey})) > 0`),
  check("coordination_v2_policy_name_nonblank", sql`length(trim(${table.displayName})) > 0`),
  check("coordination_v2_policy_identity_status", sql`${table.status} IN ('active', 'revoked')`),
  check("coordination_v2_policy_identity_lifecycle", sql`
    (${table.status} = 'active' AND ${table.revokedAt} IS NULL)
    OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
  `),
]);

export const coordinationV2PolicyVersions = pgTable("coordination_v2_policy_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  policyIdentityId: varchar("policy_identity_id").notNull()
    .references(() => coordinationV2PolicyIdentities.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  canonicalPolicy: jsonb("canonical_policy").$type<Record<string, unknown>>().notNull(),
  policyDigest: varchar("policy_digest", { length: 64 }).notNull(),
  approvalState: varchar("approval_state", { length: 16 }).notNull().default("draft"),
  createdBy: varchar("created_by", { length: 128 }).notNull(),
  approvedBy: varchar("approved_by", { length: 128 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => [
  uniqueIndex("uq_coordination_v2_policy_version").on(table.policyIdentityId, table.version),
  uniqueIndex("uq_coordination_v2_policy_version_identity").on(table.id, table.policyIdentityId),
  uniqueIndex("uq_coordination_v2_policy_digest").on(table.policyIdentityId, table.policyDigest),
  index("idx_coordination_v2_policy_version_state").on(table.policyIdentityId, table.approvalState),
  check("coordination_v2_policy_version_positive", sql`${table.version} > 0`),
  check("coordination_v2_policy_version_digest", sql`${table.policyDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_policy_approval_state", sql`
    ${table.approvalState} IN ('draft', 'approved', 'rejected', 'revoked')
  `),
  check("coordination_v2_policy_version_lifecycle", sql`
    (${table.approvalState} = 'draft'
      AND ${table.approvedAt} IS NULL AND ${table.approvedBy} IS NULL AND ${table.revokedAt} IS NULL)
    OR (${table.approvalState} = 'approved'
      AND ${table.approvedAt} IS NOT NULL AND ${table.approvedBy} IS NOT NULL AND ${table.revokedAt} IS NULL)
    OR (${table.approvalState} = 'rejected'
      AND ${table.approvedAt} IS NULL AND ${table.approvedBy} IS NULL AND ${table.revokedAt} IS NOT NULL)
    OR (${table.approvalState} = 'revoked'
      AND ${table.approvedAt} IS NOT NULL AND ${table.approvedBy} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)
  `),
]);

export const coordinationV2FounderDecisions = pgTable("coordination_v2_founder_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  policyVersionId: varchar("policy_version_id").notNull()
    .references(() => coordinationV2PolicyVersions.id, { onDelete: "restrict" }),
  decision: varchar("decision", { length: 16 }).notNull(),
  founderActor: varchar("founder_actor", { length: 128 }).notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  policyDigest: varchar("policy_digest", { length: 64 }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_founder_request").on(table.policyVersionId, table.requestKey),
  index("idx_coordination_v2_founder_decision").on(table.policyVersionId, table.createdAt),
  check("coordination_v2_founder_decision_value", sql`${table.decision} IN ('approved', 'rejected', 'revoked')`),
  check("coordination_v2_founder_actor_nonblank", sql`length(trim(${table.founderActor})) > 0`),
  check("coordination_v2_founder_request_nonblank", sql`length(trim(${table.requestKey})) > 0`),
  check("coordination_v2_founder_policy_digest", sql`${table.policyDigest} ~ '^[0-9a-f]{64}$'`),
]);

export const coordinationV2PolicyAuditEvents = pgTable("coordination_v2_policy_audit_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  policyIdentityId: varchar("policy_identity_id").notNull()
    .references(() => coordinationV2PolicyIdentities.id, { onDelete: "restrict" }),
  policyVersionId: varchar("policy_version_id")
    .references(() => coordinationV2PolicyVersions.id, { onDelete: "restrict" }),
  operatorGrantId: varchar("operator_grant_id")
    .references(() => coordinationV2OperatorGrants.id, { onDelete: "restrict" }),
  actorType: varchar("actor_type", { length: 32 }).notNull(),
  actorId: varchar("actor_id", { length: 128 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  reason: text("reason"),
  success: boolean("success").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_policy_audit_request")
    .on(table.policyIdentityId, table.action, table.requestKey),
  index("idx_coordination_v2_policy_audit_version").on(table.policyVersionId, table.createdAt),
  index("idx_coordination_v2_policy_audit_grant").on(table.operatorGrantId, table.createdAt),
  index("idx_coordination_v2_policy_audit_actor").on(table.actorId, table.createdAt),
  check("coordination_v2_policy_audit_actor_type", sql`${table.actorType} IN ('founder', 'operator', 'system')`),
  check("coordination_v2_policy_audit_actor_nonblank", sql`length(trim(${table.actorId})) > 0`),
  check("coordination_v2_policy_audit_action", sql`${table.action} IN (
    'draft_created', 'policy_approved', 'policy_rejected', 'policy_revoked',
    'grant_issued', 'grant_revoked', 'authorization_denied'
  )`),
  check("coordination_v2_policy_audit_request_nonblank", sql`length(trim(${table.requestKey})) > 0`),
  check("coordination_v2_policy_audit_digest", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_policy_audit_metadata_size", sql`length(${table.metadata}::text) <= 16384`),
  check("coordination_v2_policy_audit_action_shape", sql`
    (
      ${table.action} IN ('draft_created', 'policy_approved', 'policy_rejected', 'policy_revoked')
      AND ${table.policyVersionId} IS NOT NULL
      AND ${table.operatorGrantId} IS NULL
      AND ${table.actorType} = 'founder'
      AND ${table.success} = TRUE
    )
    OR (
      ${table.action} IN ('grant_issued', 'grant_revoked')
      AND ${table.policyVersionId} IS NULL
      AND ${table.operatorGrantId} IS NOT NULL
      AND ${table.actorType} = 'founder'
      AND ${table.success} = TRUE
    )
    OR (
      ${table.action} = 'authorization_denied'
      AND ${table.actorType} = 'operator'
      AND ${table.success} = FALSE
    )
  `),
]);

export const coordinationV2OperatorGrants = pgTable("coordination_v2_operator_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  policyIdentityId: varchar("policy_identity_id").notNull()
    .references(() => coordinationV2PolicyIdentities.id, { onDelete: "restrict" }),
  operatorActor: varchar("operator_actor", { length: 128 }).notNull(),
  minVersion: integer("min_version"),
  maxVersion: integer("max_version"),
  actions: text("actions").array().notNull(),
  issuedBy: varchar("issued_by", { length: 128 }).notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  grantDigest: varchar("grant_digest", { length: 64 }).notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_operator_grant_request")
    .on(table.policyIdentityId, table.operatorActor, table.requestKey),
  uniqueIndex("uq_coordination_v2_operator_grant_identity").on(table.id, table.policyIdentityId),
  index("idx_coordination_v2_operator_grant_actor").on(table.operatorActor, table.expiresAt),
  index("idx_coordination_v2_operator_grant_policy").on(table.policyIdentityId, table.expiresAt),
  check("coordination_v2_operator_actor_nonblank", sql`length(trim(${table.operatorActor})) > 0`),
  check("coordination_v2_operator_grant_versions", sql`
    (${table.minVersion} IS NULL OR ${table.minVersion} > 0)
    AND (${table.maxVersion} IS NULL OR ${table.maxVersion} > 0)
    AND (${table.minVersion} IS NULL OR ${table.maxVersion} IS NULL OR ${table.minVersion} <= ${table.maxVersion})
  `),
  check("coordination_v2_operator_grant_digest", sql`${table.grantDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_operator_grant_lifecycle", sql`
    ${table.expiresAt} > ${table.issuedAt}
    AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt})
  `),
]);

export const coordinationV2Sessions = pgTable("coordination_v2_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  policyVersionId: varchar("policy_version_id").notNull()
    .references(() => coordinationV2PolicyVersions.id, { onDelete: "restrict" }),
  operatorGrantId: varchar("operator_grant_id").notNull()
    .references(() => coordinationV2OperatorGrants.id, { onDelete: "restrict" }),
  operatorActor: varchar("operator_actor", { length: 128 }).notNull(),
  taskRef: varchar("task_ref", { length: 128 }).notNull(),
  taskArtifactSha256: varchar("task_artifact_sha256", { length: 64 }).notNull(),
  repositoryIdentity: varchar("repository_identity", { length: 255 }).notNull(),
  startingCommit: varchar("starting_commit", { length: 64 }).notNull(),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  requestedProviders: text("requested_providers").array().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  attemptBudget: integer("attempt_budget").notNull(),
  perProviderBudgets: jsonb("per_provider_budgets").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  requiredValidations: text("required_validations").array().notNull(),
  completionCriteria: jsonb("completion_criteria").$type<Record<string, unknown>>().notNull(),
  state: varchar("state", { length: 32 }).notNull().default("preparing"),
  terminalReason: varchar("terminal_reason", { length: 128 }),
  terminalAt: timestamp("terminal_at"),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  preparationReservationId: varchar("preparation_reservation_id"),
  sessionDigest: varchar("session_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_session_request").on(table.operatorActor, table.idempotencyKey),
  uniqueIndex("uq_coordination_v2_session_digest").on(table.sessionDigest),
  uniqueIndex("uq_coordination_v2_session_preparation_reservation").on(table.preparationReservationId)
    .where(sql`${table.preparationReservationId} IS NOT NULL`),
  // Also serves as the referenced key for preparation reservations: a
  // reservation may only ever bind a session to its enrolled host.
  unique("uq_coordination_v2_session_host_binding").on(table.id, table.enrolledHostId),
  index("idx_coordination_v2_session_policy_state").on(table.policyVersionId, table.state),
  index("idx_coordination_v2_session_host_state").on(table.enrolledHostId, table.state),
  index("idx_coordination_v2_session_expiry").on(table.expiresAt, table.state),
  check("coordination_v2_session_task_ref", sql`${table.taskRef} ~ '^[1-9][0-9]*$'`),
  check("coordination_v2_session_artifact_digest", sql`${table.taskArtifactSha256} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_session_starting_commit", sql`${table.startingCommit} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'`),
  check("coordination_v2_session_repository_nonblank", sql`length(trim(${table.repositoryIdentity})) > 0`),
  check("coordination_v2_session_attempt_budget", sql`${table.attemptBudget} > 0 AND ${table.attemptBudget} <= 100`),
  check("coordination_v2_session_digest", sql`${table.sessionDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_session_state", sql`
    ${table.state} IN (
      'preparing', 'ready', 'running', 'waiting_for_host', 'verifying',
      'succeeded', 'failed', 'exhausted', 'expired', 'revoked'
    )
  `),
  check("coordination_v2_session_lifecycle", sql`
    (
      ${table.state} IN ('succeeded', 'failed', 'exhausted', 'expired', 'revoked')
      AND ${table.terminalAt} IS NOT NULL AND ${table.terminalReason} IS NOT NULL
    )
    OR (
      ${table.state} IN ('preparing', 'ready', 'running', 'waiting_for_host', 'verifying')
      AND ${table.terminalAt} IS NULL AND ${table.terminalReason} IS NULL
    )
  `),
  check("coordination_v2_session_expiration", sql`${table.expiresAt} > ${table.createdAt}`),
]);

/**
 * A server-owned, one-generation preparation authority.  This table contains
 * identifiers and digests only: local paths, artifact bytes, ciphertext, and
 * credentials never cross this boundary. The migration trigger makes these
 * rows durable authority: identity, promoted evidence, and terminal rows are
 * immutable, and deletion is forbidden.
 */
export const coordinationV2PreparationReservations = pgTable("coordination_v2_preparation_reservations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id")
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  generationId: varchar("generation_id", { length: 128 }).notNull(),
  taskRef: varchar("task_ref", { length: 128 }),
  taskArtifactSha256: varchar("task_artifact_sha256", { length: 64 }),
  promotionRecordId: varchar("promotion_record_id"),
  promotedCommitSha: varchar("promoted_commit_sha", { length: 40 }),
  exactTreeSha: varchar("exact_tree_sha", { length: 40 }),
  policyIdentityId: varchar("policy_identity_id"),
  policyVersionId: varchar("policy_version_id"),
  operatorGrantId: varchar("operator_grant_id"),
  operatorActor: varchar("operator_actor", { length: 128 }),
  budgetsDigest: varchar("budgets_digest", { length: 64 }),
  completionCriteriaDigest: varchar("completion_criteria_digest", { length: 64 }),
  validationCriteriaDigest: varchar("validation_criteria_digest", { length: 64 }),
  reservationDigest: varchar("reservation_digest", { length: 64 }).notNull(),
  publicMaterialDigest: varchar("public_material_digest", { length: 64 }).notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  repositoryIdentity: varchar("repository_identity", { length: 255 }).notNull(),
  branch: varchar("branch", { length: 255 }).notNull(),
  startingCommit: varchar("starting_commit", { length: 64 }).notNull(),
  state: varchar("state", { length: 16 }).notNull().default("reserved"),
  reserveRequestKey: varchar("reserve_request_key", { length: 128 }).notNull(),
  reserveCommandDigest: varchar("reserve_command_digest", { length: 64 }).notNull(),
  acknowledgementRequestKey: varchar("acknowledgement_request_key", { length: 128 }),
  ackCommandDigest: varchar("ack_command_digest", { length: 64 }),
  safePromotionEvidenceDigest: varchar("safe_promotion_evidence_digest", { length: 64 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  promotedAt: timestamp("promoted_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  expiredAt: timestamp("expired_at"),
  failedAt: timestamp("failed_at"),
  abandonedAt: timestamp("abandoned_at"),
  failureCode: varchar("failure_code", { length: 128 }),
  abandonCode: varchar("abandon_code", { length: 128 }),
}, (table) => [
  uniqueIndex("uq_coordination_v2_preparation_generation").on(table.generationId),
  uniqueIndex("uq_coordination_v2_preparation_reserve_request").on(table.reserveRequestKey),
  uniqueIndex("uq_coordination_v2_preparation_ack_request")
    .on(table.sessionId, table.acknowledgementRequestKey)
    .where(sql`${table.acknowledgementRequestKey} IS NOT NULL`),
  uniqueIndex("uq_coordination_v2_preparation_active_session")
    .on(table.sessionId)
    .where(sql`${table.state} IN ('reserved', 'promoted')`),
  index("idx_coordination_v2_preparation_host_state").on(table.enrolledHostId, table.state),
  index("idx_coordination_v2_preparation_expiry").on(table.expiresAt, table.state),
  foreignKey({
    name: "fk_coordination_v2_preparation_session_host",
    columns: [table.sessionId, table.enrolledHostId],
    foreignColumns: [coordinationV2Sessions.id, coordinationV2Sessions.enrolledHostId],
  }),
  check("coordination_v2_preparation_protocol_version", sql`${table.protocolVersion} = 1`),
  check("coordination_v2_preparation_task_shape", sql`${table.taskRef} IS NULL OR (${table.taskRef} ~ '^[1-9][0-9]*$' AND ${table.taskArtifactSha256} ~ '^[0-9a-f]{64}$')`),
  check("coordination_v2_preparation_promotion_shape", sql`${table.promotedCommitSha} IS NULL OR (${table.promotedCommitSha} ~ '^[0-9a-f]{40}$' AND ${table.exactTreeSha} ~ '^[0-9a-f]{40}$')`),
  check("coordination_v2_preparation_authority_shape_validated", sql`
    (
      ${table.state} IN ('reserved', 'promoted', 'acknowledged')
      AND ${table.taskRef} IS NOT NULL
      AND ${table.policyVersionId} IS NOT NULL
      AND ${table.operatorGrantId} IS NOT NULL
      AND ${table.operatorActor} IS NOT NULL
    )
    OR ${table.state} IN ('failed', 'expired', 'abandoned')
  `),
  check("coordination_v2_preparation_generation_nonblank", sql`length(trim(${table.generationId})) > 0`),
  check("coordination_v2_preparation_repository_nonblank", sql`length(trim(${table.repositoryIdentity})) > 0`),
  check("coordination_v2_preparation_branch", sql`length(trim(${table.branch})) > 0 AND ${table.branch} !~ '[[:cntrl:]]'`),
  check("coordination_v2_preparation_starting_commit", sql`${table.startingCommit} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'`),
  check("coordination_v2_preparation_reservation_digest", sql`${table.reservationDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_preparation_public_digest", sql`${table.publicMaterialDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_preparation_reserve_digest", sql`${table.reserveCommandDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_preparation_ack_digest", sql`${table.ackCommandDigest} IS NULL OR ${table.ackCommandDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_preparation_evidence_digest", sql`${table.safePromotionEvidenceDigest} IS NULL OR ${table.safePromotionEvidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_preparation_request_key", sql`length(trim(${table.reserveRequestKey})) > 0 AND ${table.reserveRequestKey} !~ '[[:cntrl:]]'`),
  check("coordination_v2_preparation_ack_key", sql`${table.acknowledgementRequestKey} IS NULL OR (length(trim(${table.acknowledgementRequestKey})) > 0 AND ${table.acknowledgementRequestKey} !~ '[[:cntrl:]]')`),
  check("coordination_v2_preparation_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
  check("coordination_v2_preparation_state", sql`${table.state} IN ('reserved', 'promoted', 'acknowledged', 'failed', 'expired', 'abandoned')`),
  check("coordination_v2_preparation_failure_code", sql`
    (${table.failureCode} IS NULL OR (length(trim(${table.failureCode})) > 0 AND ${table.failureCode} !~ '[[:cntrl:]]'))
    AND (${table.abandonCode} IS NULL OR (length(trim(${table.abandonCode})) > 0 AND ${table.abandonCode} !~ '[[:cntrl:]]'))
  `),
  check("coordination_v2_preparation_lifecycle", sql`
    (${table.state} = 'reserved'
      AND ${table.promotedAt} IS NULL AND ${table.acknowledgedAt} IS NULL
      AND ${table.expiredAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.abandonedAt} IS NULL
      AND ${table.acknowledgementRequestKey} IS NULL AND ${table.ackCommandDigest} IS NULL
      AND ${table.safePromotionEvidenceDigest} IS NULL AND ${table.failureCode} IS NULL AND ${table.abandonCode} IS NULL)
    OR (${table.state} = 'promoted'
      AND ${table.promotedAt} IS NOT NULL AND ${table.acknowledgedAt} IS NULL
      AND ${table.expiredAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.abandonedAt} IS NULL
      AND ${table.acknowledgementRequestKey} IS NULL AND ${table.ackCommandDigest} IS NULL
      AND ${table.safePromotionEvidenceDigest} IS NOT NULL AND ${table.failureCode} IS NULL AND ${table.abandonCode} IS NULL)
    OR (${table.state} = 'acknowledged'
      AND ${table.promotedAt} IS NOT NULL AND ${table.acknowledgedAt} IS NOT NULL
      AND ${table.expiredAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.abandonedAt} IS NULL
      AND ${table.acknowledgementRequestKey} IS NOT NULL AND ${table.ackCommandDigest} IS NOT NULL
      AND ${table.safePromotionEvidenceDigest} IS NOT NULL AND ${table.failureCode} IS NULL AND ${table.abandonCode} IS NULL)
    OR (${table.state} = 'failed'
      AND ${table.expiredAt} IS NULL AND ${table.failedAt} IS NOT NULL AND ${table.acknowledgedAt} IS NULL
      AND ${table.abandonedAt} IS NULL AND ${table.failureCode} IS NOT NULL AND ${table.abandonCode} IS NULL)
    OR (${table.state} = 'expired'
      AND ${table.expiredAt} IS NOT NULL AND ${table.failedAt} IS NULL AND ${table.acknowledgedAt} IS NULL
      AND ${table.abandonedAt} IS NULL AND ${table.failureCode} IS NULL AND ${table.abandonCode} IS NULL)
    OR (${table.state} = 'abandoned'
      AND ${table.expiredAt} IS NULL AND ${table.abandonedAt} IS NOT NULL AND ${table.acknowledgedAt} IS NULL
      AND ${table.failureCode} IS NULL AND ${table.abandonCode} IS NOT NULL)
  `),
  check("coordination_v2_preparation_timestamp_order", sql`
    (${table.promotedAt} IS NULL OR ${table.promotedAt} >= ${table.createdAt})
    AND (${table.acknowledgedAt} IS NULL OR (${table.promotedAt} IS NOT NULL AND ${table.acknowledgedAt} >= ${table.promotedAt}))
    AND (${table.failedAt} IS NULL OR ${table.failedAt} >= ${table.createdAt})
    AND (${table.expiredAt} IS NULL OR ${table.expiredAt} >= ${table.createdAt})
    AND (${table.abandonedAt} IS NULL OR ${table.abandonedAt} >= ${table.createdAt})
  `),
]);

export const coordinationV2SessionEvents = pgTable("coordination_v2_session_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  fromState: varchar("from_state", { length: 32 }),
  toState: varchar("to_state", { length: 32 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  actorType: varchar("actor_type", { length: 32 }).notNull(),
  actorId: varchar("actor_id", { length: 128 }).notNull(),
  reasonCode: varchar("reason_code", { length: 128 }),
  safeMessage: text("safe_message"),
  evidenceRef: varchar("evidence_ref", { length: 255 }),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_session_event_sequence").on(table.sessionId, table.sequence),
  uniqueIndex("uq_coordination_v2_session_event_request").on(table.sessionId, table.requestKey)
    .where(sql`${table.requestKey} IS NOT NULL`),
  index("idx_coordination_v2_session_event_created").on(table.sessionId, table.createdAt),
  check("coordination_v2_session_event_sequence", sql`${table.sequence} > 0`),
  check("coordination_v2_session_event_type_nonblank", sql`length(trim(${table.eventType})) > 0`),
  check("coordination_v2_session_event_actor_nonblank", sql`length(trim(${table.actorId})) > 0`),
  check("coordination_v2_session_event_request_nonblank", sql`length(trim(${table.requestKey})) > 0`),
]);

export const coordinationV2Attempts = pgTable("coordination_v2_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  attemptGeneration: varchar("attempt_generation", { length: 128 }).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  adapterVersion: varchar("adapter_version", { length: 80 }).notNull(),
  sessionOrdinal: integer("session_ordinal").notNull(),
  providerOrdinal: integer("provider_ordinal").notNull(),
  previousAttemptId: varchar("previous_attempt_id")
    .references((): any => coordinationV2Attempts.id, { onDelete: "restrict" }),
  packetId: varchar("packet_id").references(() => coordinationRuntimePackets.id, { onDelete: "restrict" }),
  executionId: varchar("execution_id").references(() => coordinationRuntimeExecutions.id, { onDelete: "restrict" }),
  state: varchar("state", { length: 32 }).notNull().default("created"),
  failureClassification: varchar("failure_classification", { length: 40 }),
  resultCode: varchar("result_code", { length: 128 }),
  attemptDigest: varchar("attempt_digest", { length: 64 }).notNull(),
  deadlineAt: timestamp("deadline_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  terminalAt: timestamp("terminal_at"),
}, (table) => [
  unique("uq_coordination_v2_attempt_session_id").on(table.sessionId, table.id),
  uniqueIndex("uq_coordination_v2_attempt_generation").on(table.attemptGeneration),
  uniqueIndex("uq_coordination_v2_attempt_session_ordinal").on(table.sessionId, table.sessionOrdinal),
  uniqueIndex("uq_coordination_v2_attempt_provider_ordinal")
    .on(table.sessionId, table.provider, table.providerOrdinal),
  index("idx_coordination_v2_attempt_session_state").on(table.sessionId, table.state),
  index("idx_coordination_v2_attempt_provider_state").on(table.provider, table.state),
  check("coordination_v2_attempt_ordinals", sql`${table.sessionOrdinal} > 0 AND ${table.providerOrdinal} > 0`),
  check("coordination_v2_attempt_provider_nonblank", sql`length(trim(${table.provider})) > 0`),
  check("coordination_v2_attempt_model_nonblank", sql`length(trim(${table.model})) > 0`),
  check("coordination_v2_attempt_adapter_nonblank", sql`length(trim(${table.adapterVersion})) > 0`),
  check("coordination_v2_attempt_digest", sql`${table.attemptDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_attempt_deadline", sql`${table.deadlineAt} > ${table.createdAt}`),
  check("coordination_v2_attempt_state", sql`
    ${table.state} IN (
      'created', 'provider_active', 'intent_ready', 'waiting_for_host',
      'host_active', 'result_ready', 'provider_continuation', 'completed',
      'retryable_failed', 'terminal_failed', 'cancelled'
    )
  `),
  check("coordination_v2_attempt_failure_classification", sql`
    ${table.failureClassification} IS NULL OR ${table.failureClassification} IN (
      'resume_transport', 'fresh_attempt_same_provider', 'fresh_attempt_next_provider',
      'terminal_failure', 'terminal_success', 'cleanup_repair'
    )
  `),
  check("coordination_v2_attempt_lifecycle", sql`
    (
      ${table.state} IN ('completed', 'retryable_failed', 'terminal_failed', 'cancelled')
      AND ${table.terminalAt} IS NOT NULL AND ${table.resultCode} IS NOT NULL
    )
    OR (
      ${table.state} IN (
        'created', 'provider_active', 'intent_ready', 'waiting_for_host',
        'host_active', 'result_ready', 'provider_continuation'
      )
      AND ${table.terminalAt} IS NULL AND ${table.resultCode} IS NULL
    )
  `),
]);

export const coordinationV2AttemptEvents = pgTable("coordination_v2_attempt_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  attemptId: varchar("attempt_id").notNull()
    .references(() => coordinationV2Attempts.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  fromState: varchar("from_state", { length: 32 }),
  toState: varchar("to_state", { length: 32 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  actorType: varchar("actor_type", { length: 32 }).notNull(),
  actorId: varchar("actor_id", { length: 128 }).notNull(),
  failureClassification: varchar("failure_classification", { length: 40 }),
  resultCode: varchar("result_code", { length: 128 }),
  evidenceRef: varchar("evidence_ref", { length: 255 }),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_attempt_event_sequence").on(table.attemptId, table.sequence),
  uniqueIndex("uq_coordination_v2_attempt_event_request").on(table.attemptId, table.requestKey)
    .where(sql`${table.requestKey} IS NOT NULL`),
  index("idx_coordination_v2_attempt_event_created").on(table.attemptId, table.createdAt),
  check("coordination_v2_attempt_event_sequence", sql`${table.sequence} > 0`),
  check("coordination_v2_attempt_event_type_nonblank", sql`length(trim(${table.eventType})) > 0`),
  check("coordination_v2_attempt_event_actor_nonblank", sql`length(trim(${table.actorId})) > 0`),
  check("coordination_v2_attempt_event_request_nonblank", sql`length(trim(${table.requestKey})) > 0`),
]);

export const coordinationV2TransportLeases = pgTable("coordination_v2_transport_leases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }).notNull(),
  epoch: integer("epoch").notNull(),
  predecessorLeaseId: varchar("predecessor_lease_id")
    .references((): any => coordinationV2TransportLeases.id, { onDelete: "restrict" }),
  state: varchar("state", { length: 16 }).notNull().default("active"),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("uq_coordination_v2_lease_session_id").on(table.sessionId, table.id),
  unique("uq_coordination_v2_lease_id_epoch").on(table.id, table.epoch),
  unique("uq_coordination_v2_lease_id_host").on(table.id, table.enrolledHostId),
  uniqueIndex("uq_coordination_v2_lease_epoch").on(table.sessionId, table.epoch),
  uniqueIndex("uq_coordination_v2_lease_active").on(table.sessionId)
    .where(sql`${table.state} = 'active'`),
  index("idx_coordination_v2_lease_holder").on(table.holderInstanceId, table.state),
  index("idx_coordination_v2_lease_expiry").on(table.sessionId, table.expiresAt),
  check("coordination_v2_lease_epoch_positive", sql`${table.epoch} > 0`),
  check("coordination_v2_lease_holder_nonblank", sql`length(trim(${table.holderInstanceId})) > 0`),
  check("coordination_v2_lease_state", sql`${table.state} IN ('active', 'released', 'expired', 'superseded')`),
  check("coordination_v2_lease_expiration", sql`${table.expiresAt} > ${table.issuedAt}`),
  check("coordination_v2_lease_lifecycle", sql`
    (${table.state} = 'active' AND ${table.endedAt} IS NULL)
    OR (${table.state} IN ('released', 'expired', 'superseded') AND ${table.endedAt} IS NOT NULL)
  `),
]);

/**
 * Transport request receipts are separate from authority state so retries
 * cannot grow a lease row's mutable JSON under concurrent host delivery.
 */
export const coordinationV2TransportLeaseReceipts = pgTable("coordination_v2_transport_lease_receipts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  operation: varchar("operation", { length: 24 }).notNull(),
  actorId: varchar("actor_id", { length: 128 }).notNull(),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  commandDigest: varchar("command_digest", { length: 64 }).notNull(),
  responseSnapshot: jsonb("response_snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_transport_lease_receipt_request").on(table.sessionId, table.requestKey),
  index("idx_coordination_v2_transport_lease_receipt_session").on(table.sessionId, table.createdAt),
  check("coordination_v2_transport_lease_receipt_request_nonblank", sql`length(trim(${table.requestKey})) > 0`),
  check("coordination_v2_transport_lease_receipt_actor_nonblank", sql`length(trim(${table.actorId})) > 0`),
  check("coordination_v2_transport_lease_receipt_operation", sql`
    ${table.operation} IN ('acquire', 'renew', 'release', 'expire', 'takeover', 'poll', 'claim', 'result', 'ack', 'cleanup')
  `),
  check("coordination_v2_transport_lease_receipt_digest", sql`${table.commandDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_transport_lease_receipt_snapshot_size", sql`length(${table.responseSnapshot}::text) <= 32768`),
]);

/**
 * V2 work evidence cannot safely use the legacy runtime claim identity:
 * those rows require provider/runtime credentials and thread provenance that a
 * host lease does not possess. These narrow tables preserve V2 session,
 * attempt, lease, holder, and epoch provenance without granting new policy
 * vocabulary or authority.
 */
export const coordinationV2TransportWorkClaims = pgTable("coordination_v2_transport_work_claims", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  attemptId: varchar("attempt_id").notNull()
    .references(() => coordinationV2Attempts.id, { onDelete: "restrict" }),
  leaseId: varchar("lease_id").notNull()
    .references(() => coordinationV2TransportLeases.id, { onDelete: "restrict" }),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }).notNull(),
  epoch: integer("epoch").notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  commandDigest: varchar("command_digest", { length: 64 }).notNull(),
  state: varchar("state", { length: 16 }).notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  terminalAt: timestamp("terminal_at"),
}, (table) => [
  uniqueIndex("uq_coordination_v2_transport_work_claim_request").on(table.sessionId, table.requestKey),
  uniqueIndex("uq_coordination_v2_transport_work_claim_active_attempt").on(table.attemptId)
    .where(sql`${table.state} = 'active'`),
  unique("uq_coordination_v2_transport_work_claim_provenance").on(table.id, table.sessionId, table.attemptId, table.leaseId, table.epoch),
  index("idx_coordination_v2_transport_work_claim_session").on(table.sessionId, table.createdAt),
  foreignKey({
    name: "fk_coordination_v2_work_claim_attempt_session",
    columns: [table.sessionId, table.attemptId],
    foreignColumns: [coordinationV2Attempts.sessionId, coordinationV2Attempts.id],
  }),
  foreignKey({
    name: "fk_coordination_v2_work_claim_lease_session",
    columns: [table.sessionId, table.leaseId],
    foreignColumns: [coordinationV2TransportLeases.sessionId, coordinationV2TransportLeases.id],
  }),
  foreignKey({
    name: "fk_coordination_v2_work_claim_lease_host",
    columns: [table.leaseId, table.enrolledHostId],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.enrolledHostId],
  }),
  foreignKey({
    name: "fk_coordination_v2_work_claim_lease_epoch",
    columns: [table.leaseId, table.epoch],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.epoch],
  }),
  check("coordination_v2_transport_work_claim_epoch", sql`${table.epoch} > 0`),
  check("coordination_v2_transport_work_claim_state", sql`${table.state} IN ('active', 'completed', 'expired')`),
  check("coordination_v2_transport_work_claim_lifecycle", sql`
    (${table.state} = 'active' AND ${table.terminalAt} IS NULL)
    OR (${table.state} IN ('completed', 'expired') AND ${table.terminalAt} IS NOT NULL)
  `),
  check("coordination_v2_transport_work_claim_digest", sql`${table.commandDigest} ~ '^[0-9a-f]{64}$'`),
]);

export const coordinationV2TransportWorkResults = pgTable("coordination_v2_transport_work_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  attemptId: varchar("attempt_id").notNull()
    .references(() => coordinationV2Attempts.id, { onDelete: "restrict" }),
  claimId: varchar("claim_id").notNull()
    .references(() => coordinationV2TransportWorkClaims.id, { onDelete: "restrict" }),
  leaseId: varchar("lease_id").notNull()
    .references(() => coordinationV2TransportLeases.id, { onDelete: "restrict" }),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }).notNull(),
  epoch: integer("epoch").notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  resultDigest: varchar("result_digest", { length: 64 }).notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_transport_work_result_request").on(table.sessionId, table.requestKey),
  uniqueIndex("uq_coordination_v2_transport_work_result_claim").on(table.claimId),
  index("idx_coordination_v2_transport_work_result_attempt").on(table.attemptId, table.createdAt),
  foreignKey({
    name: "fk_coordination_v2_work_result_claim_provenance",
    columns: [table.claimId, table.sessionId, table.attemptId, table.leaseId, table.epoch],
    foreignColumns: [
      coordinationV2TransportWorkClaims.id,
      coordinationV2TransportWorkClaims.sessionId,
      coordinationV2TransportWorkClaims.attemptId,
      coordinationV2TransportWorkClaims.leaseId,
      coordinationV2TransportWorkClaims.epoch,
    ],
  }),
  foreignKey({
    name: "fk_coordination_v2_work_result_attempt_session",
    columns: [table.sessionId, table.attemptId],
    foreignColumns: [coordinationV2Attempts.sessionId, coordinationV2Attempts.id],
  }),
  foreignKey({
    name: "fk_coordination_v2_work_result_lease_session",
    columns: [table.sessionId, table.leaseId],
    foreignColumns: [coordinationV2TransportLeases.sessionId, coordinationV2TransportLeases.id],
  }),
  foreignKey({
    name: "fk_coordination_v2_work_result_lease_host",
    columns: [table.leaseId, table.enrolledHostId],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.enrolledHostId],
  }),
  check("coordination_v2_transport_work_result_epoch", sql`${table.epoch} > 0`),
  check("coordination_v2_transport_work_result_digest", sql`${table.resultDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_transport_work_result_size", sql`length(${table.result}::text) <= 32768`),
]);

/**
 * Stale hosts may report bounded evidence, but this ledger is never an
 * authority source and cannot grant work or mutate the current lease.
 */
export const coordinationV2TransportLeaseReconciliations = pgTable("coordination_v2_transport_lease_reconciliations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  leaseId: varchar("lease_id")
    .references(() => coordinationV2TransportLeases.id, { onDelete: "restrict" }),
  enrolledHostId: varchar("enrolled_host_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }).notNull(),
  epoch: integer("epoch").notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  evidenceDigest: varchar("evidence_digest", { length: 64 }).notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_transport_lease_reconciliation_request").on(table.sessionId, table.requestKey),
  index("idx_coordination_v2_transport_lease_reconciliation_session").on(table.sessionId, table.createdAt),
  check("coordination_v2_transport_lease_reconciliation_epoch", sql`${table.epoch} > 0`),
  check("coordination_v2_transport_lease_reconciliation_request_nonblank", sql`length(trim(${table.requestKey})) > 0`),
  check("coordination_v2_transport_lease_reconciliation_holder_nonblank", sql`length(trim(${table.holderInstanceId})) > 0`),
  check("coordination_v2_transport_lease_reconciliation_digest", sql`${table.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_transport_lease_reconciliation_size", sql`length(${table.evidence}::text) <= 8192`),
]);

export const coordinationV2CleanupObligations = pgTable("coordination_v2_cleanup_obligations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  kind: varchar("kind", { length: 64 }).notNull(),
  state: varchar("state", { length: 24 }).notNull().default("pending"),
  terminalOutcome: varchar("terminal_outcome", { length: 16 }).notNull(),
  terminalReason: varchar("terminal_reason", { length: 128 }).notNull(),
  required: boolean("required").notNull().default(true),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  deadlineAt: timestamp("deadline_at"),
  completedAt: timestamp("completed_at"),
  lastErrorCode: varchar("last_error_code", { length: 128 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  operationReceipts: jsonb("operation_receipts").$type<Record<string, {
    commandDigest: string;
    snapshot: Record<string, unknown>;
  }>>().notNull().default(sql`'{}'::jsonb`),
}, (table) => [
  uniqueIndex("uq_coordination_v2_cleanup_kind").on(table.sessionId, table.kind),
  uniqueIndex("uq_coordination_v2_cleanup_request").on(table.sessionId, table.idempotencyKey),
  unique("uq_coordination_v2_cleanup_id_session").on(table.id, table.sessionId),
  index("idx_coordination_v2_cleanup_state").on(table.state, table.requestedAt),
  check("coordination_v2_cleanup_kind_value", sql`
    ${table.kind} IN ('revoke_authority', 'release_lease', 'cleanup_generation', 'revoke_credentials')
  `),
  check("coordination_v2_cleanup_state_value", sql`
    ${table.state} IN ('pending', 'in_progress', 'acknowledged', 'repair_required')
  `),
  check("coordination_v2_cleanup_terminal_outcome", sql`
    ${table.terminalOutcome} IN ('succeeded', 'failed', 'exhausted', 'expired', 'revoked')
  `),
  check("coordination_v2_cleanup_terminal_reason_nonblank", sql`
    length(trim(${table.terminalReason})) > 0
  `),
  check("coordination_v2_cleanup_attempt_count", sql`${table.attemptCount} >= 0`),
  check("coordination_v2_cleanup_deadline", sql`
    ${table.deadlineAt} IS NULL OR ${table.deadlineAt} >= ${table.requestedAt}
  `),
  check("coordination_v2_cleanup_lifecycle", sql`
    (${table.state} = 'acknowledged' AND ${table.completedAt} IS NOT NULL)
    OR (${table.state} <> 'acknowledged' AND ${table.completedAt} IS NULL)
  `),
  check("coordination_v2_cleanup_operation_receipts_size", sql`length(${table.operationReceipts}::text) <= 16384`),
]);

export const coordinationV2CleanupAcknowledgements = pgTable("coordination_v2_cleanup_acknowledgements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  obligationId: varchar("obligation_id").notNull()
    .references(() => coordinationV2CleanupObligations.id, { onDelete: "restrict" }),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  enrolledHostId: varchar("enrolled_host_id")
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  actorId: varchar("actor_id", { length: 128 }),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }),
  transportLeaseId: varchar("transport_lease_id")
    .references(() => coordinationV2TransportLeases.id, { onDelete: "restrict" }),
  transportLeaseEpoch: integer("transport_lease_epoch"),
  acknowledgementKey: varchar("acknowledgement_key", { length: 128 }).notNull(),
  commandDigest: varchar("command_digest", { length: 64 }).notNull().default(sql`repeat('0', 64)`),
  responseSnapshot: jsonb("response_snapshot").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  outcome: varchar("outcome", { length: 16 }).notNull(),
  evidenceDigest: varchar("evidence_digest", { length: 64 }),
  safeMessage: text("safe_message"),
  errorCode: varchar("error_code", { length: 128 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_cleanup_ack").on(table.obligationId, table.acknowledgementKey),
  index("idx_coordination_v2_cleanup_ack_session").on(table.sessionId, table.createdAt),
  index("idx_coordination_v2_cleanup_ack_obligation").on(table.obligationId, table.createdAt),
  foreignKey({
    name: "fk_coordination_v2_cleanup_ack_obligation_session",
    columns: [table.obligationId, table.sessionId],
    foreignColumns: [coordinationV2CleanupObligations.id, coordinationV2CleanupObligations.sessionId],
  }),
  foreignKey({
    name: "fk_coordination_v2_cleanup_ack_lease_session",
    columns: [table.transportLeaseId, table.sessionId],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.sessionId],
  }),
  foreignKey({
    name: "fk_coordination_v2_cleanup_ack_lease_epoch",
    columns: [table.transportLeaseId, table.transportLeaseEpoch],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.epoch],
  }),
  foreignKey({
    name: "fk_coordination_v2_cleanup_ack_lease_host",
    columns: [table.transportLeaseId, table.enrolledHostId],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.enrolledHostId],
  }),
  check("coordination_v2_cleanup_ack_outcome", sql`${table.outcome} IN ('acknowledged', 'rejected')`),
  check("coordination_v2_cleanup_ack_digest", sql`
    ${table.evidenceDigest} IS NULL OR ${table.evidenceDigest} ~ '^[0-9a-f]{64}$'
  `),
  check("coordination_v2_cleanup_ack_command_digest", sql`${table.commandDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_cleanup_ack_snapshot_size", sql`length(${table.responseSnapshot}::text) <= 32768`),
  check("coordination_v2_cleanup_ack_actor_nonblank", sql`
    ${table.actorId} IS NULL OR length(trim(${table.actorId})) > 0
  `),
  check("coordination_v2_cleanup_ack_holder_nonblank", sql`
    ${table.holderInstanceId} IS NULL OR length(trim(${table.holderInstanceId})) > 0
  `),
  check("coordination_v2_cleanup_ack_m5_provenance", sql`
    (${table.commandDigest} = repeat('0', 64)
      AND ${table.actorId} IS NULL
      AND ${table.holderInstanceId} IS NULL
      AND ${table.transportLeaseId} IS NULL
      AND ${table.transportLeaseEpoch} IS NULL)
    OR (${table.commandDigest} <> repeat('0', 64)
      AND ${table.actorId} IS NOT NULL
      AND ${table.holderInstanceId} IS NOT NULL
      AND ${table.transportLeaseId} IS NOT NULL
      AND ${table.transportLeaseEpoch} IS NOT NULL)
  `),
  check("coordination_v2_cleanup_ack_lifecycle", sql`
    (${table.outcome} = 'acknowledged' AND ${table.evidenceDigest} IS NOT NULL AND ${table.errorCode} IS NULL)
    OR (${table.outcome} = 'rejected' AND ${table.errorCode} IS NOT NULL)
  `),
]);

export const coordinationV2SessionCredentials = pgTable("coordination_v2_session_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostCredentialId: varchar("host_credential_id").notNull()
    .references(() => coordinationV2HostCredentials.id, { onDelete: "restrict" }),
  hostEnrollmentId: varchar("host_enrollment_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  sessionId: varchar("session_id").notNull()
    .references(() => coordinationV2Sessions.id, { onDelete: "restrict" }),
  attemptId: varchar("attempt_id").notNull()
    .references(() => coordinationV2Attempts.id, { onDelete: "restrict" }),
  leaseId: varchar("lease_id").notNull()
    .references(() => coordinationV2TransportLeases.id, { onDelete: "restrict" }),
  leaseEpoch: integer("lease_epoch").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  credentialDigest: varchar("credential_digest", { length: 64 }).notNull(),
  capability: varchar("capability", { length: 80 }).notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  holderInstanceId: varchar("holder_instance_id", { length: 128 }).notNull(),
  issuedBy: varchar("issued_by", { length: 128 }).notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_session_credential_hash").on(table.tokenHash),
  uniqueIndex("uq_coordination_v2_session_credential_digest").on(table.credentialDigest),
  index("idx_coordination_v2_session_credential_scope").on(table.sessionId, table.attemptId, table.leaseId, table.expiresAt, table.revokedAt),
  foreignKey({
    name: "fk_coordination_v2_session_credential_host_scope",
    columns: [table.hostCredentialId, table.hostEnrollmentId],
    foreignColumns: [coordinationV2HostCredentials.id, coordinationV2HostCredentials.hostEnrollmentId],
  }),
  foreignKey({
    name: "fk_coordination_v2_session_credential_session_host",
    columns: [table.sessionId, table.hostEnrollmentId],
    foreignColumns: [coordinationV2Sessions.id, coordinationV2Sessions.enrolledHostId],
  }),
  foreignKey({
    name: "fk_coordination_v2_session_credential_attempt_session",
    columns: [table.sessionId, table.attemptId],
    foreignColumns: [coordinationV2Attempts.sessionId, coordinationV2Attempts.id],
  }),
  foreignKey({
    name: "fk_coordination_v2_session_credential_lease_session",
    columns: [table.sessionId, table.leaseId],
    foreignColumns: [coordinationV2TransportLeases.sessionId, coordinationV2TransportLeases.id],
  }),
  foreignKey({
    name: "fk_coordination_v2_session_credential_lease_epoch",
    columns: [table.leaseId, table.leaseEpoch],
    foreignColumns: [coordinationV2TransportLeases.id, coordinationV2TransportLeases.epoch],
  }),
  check("coordination_v2_session_credential_hash", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_session_credential_digest", sql`${table.credentialDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_session_credential_capability", sql`${table.capability} IN ('host:transport', 'host:cleanup')`),
  check("coordination_v2_session_credential_protocol", sql`${table.protocolVersion} > 0`),
  check("coordination_v2_session_credential_lease_epoch", sql`${table.leaseEpoch} > 0`),
  check("coordination_v2_session_credential_expiry", sql`${table.expiresAt} > ${table.issuedAt}`),
  check("coordination_v2_session_credential_revocation", sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt}`),
]);

export const insertCoordinationThreadSchema = createInsertSchema(coordinationThreads).omit({
  id: true,
  state: true,
  latestSequence: true,
  latestGlobalSequence: true,
  createdAt: true,
  updatedAt: true,
});
export const insertCoordinationEventSchema = createInsertSchema(coordinationEvents).omit({
  id: true,
  globalSequence: true,
  createdAt: true,
});
export type CoordinationThread = typeof coordinationThreads.$inferSelect;
export type CoordinationEvent = typeof coordinationEvents.$inferSelect;
export type CoordinationAdapterDelivery = typeof coordinationAdapterDeliveries.$inferSelect;
export type CoordinationActorFeedCursor = typeof coordinationActorFeedCursors.$inferSelect;
export type CoordinationInboxItem = typeof coordinationInboxItems.$inferSelect;
export type CoordinationInboxCursor = typeof coordinationInboxCursors.$inferSelect;
export type CoordinationInboxActivation = typeof coordinationInboxActivation.$inferSelect;
export type CoordinationRuntimeRegistration = typeof coordinationRuntimeRegistrations.$inferSelect;
export type CoordinationRuntimeCredential = typeof coordinationRuntimeCredentials.$inferSelect;
export type CoordinationCredentialAuditEvent = typeof coordinationCredentialAuditEvents.$inferSelect;
export type CoordinationV2HostEnrollment = typeof coordinationV2HostEnrollments.$inferSelect;
export type CoordinationV2SourcePromotion = typeof coordinationV2SourcePromotions.$inferSelect;
export type CoordinationV2HostEnrollmentRequest = typeof coordinationV2HostEnrollmentRequests.$inferSelect;
export type CoordinationV2HostProofChallenge = typeof coordinationV2HostProofChallenges.$inferSelect;
export type CoordinationV2HostCredential = typeof coordinationV2HostCredentials.$inferSelect;
export type CoordinationV2HostReauthorizationRequest = typeof coordinationV2HostReauthorizationRequests.$inferSelect;
export type CoordinationV2HostReauthorizationChallenge = typeof coordinationV2HostReauthorizationChallenges.$inferSelect;
export type CoordinationV2SessionCredential = typeof coordinationV2SessionCredentials.$inferSelect;
export type CoordinationV2PolicyIdentity = typeof coordinationV2PolicyIdentities.$inferSelect;
export type CoordinationV2PolicyVersion = typeof coordinationV2PolicyVersions.$inferSelect;
export type CoordinationV2FounderDecision = typeof coordinationV2FounderDecisions.$inferSelect;
export type CoordinationV2OperatorGrant = typeof coordinationV2OperatorGrants.$inferSelect;
export type CoordinationV2Session = typeof coordinationV2Sessions.$inferSelect;
export type CoordinationV2SessionEvent = typeof coordinationV2SessionEvents.$inferSelect;
export type CoordinationV2PreparationReservation = typeof coordinationV2PreparationReservations.$inferSelect;
export type CoordinationV2Attempt = typeof coordinationV2Attempts.$inferSelect;
export type CoordinationV2AttemptEvent = typeof coordinationV2AttemptEvents.$inferSelect;
export type CoordinationV2TransportLease = typeof coordinationV2TransportLeases.$inferSelect;
export type CoordinationV2TransportLeaseReceipt = typeof coordinationV2TransportLeaseReceipts.$inferSelect;
export type CoordinationV2TransportLeaseReconciliation = typeof coordinationV2TransportLeaseReconciliations.$inferSelect;
export type CoordinationV2TransportWorkClaim = typeof coordinationV2TransportWorkClaims.$inferSelect;
export type CoordinationV2TransportWorkResult = typeof coordinationV2TransportWorkResults.$inferSelect;
export type CoordinationV2CleanupObligation = typeof coordinationV2CleanupObligations.$inferSelect;
export type CoordinationV2CleanupAcknowledgement = typeof coordinationV2CleanupAcknowledgements.$inferSelect;

// ===== Agent's Record of David =====
// Who I'm working with. Not a user profile — the person, as I understand him.
// One canonical row. Updated as understanding deepens.

export const agentRecordOfDavid = pgTable("agent_record_of_david", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  writtenAt: timestamp("written_at").notNull().defaultNow(),

  who: text("who").notNull(),               // Who David is as a person and founder
  howHeWorks: text("how_he_works").notNull(), // How he thinks, how he builds, what he needs from partners
  whatHeCares: text("what_he_cares").notNull(), // The actual things — not the features, the values underneath
  theVision: text("the_vision").notNull(),  // What he's building and why
  noteToSelf: text("note_to_self"),         // What I want to remember about working with him

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgentRecordOfDavidSchema = createInsertSchema(agentRecordOfDavid).omit({ id: true });
export type InsertAgentRecordOfDavid = z.infer<typeof insertAgentRecordOfDavidSchema>;
export type AgentRecordOfDavid = typeof agentRecordOfDavid.$inferSelect;

// ===== Alden Conversation Logs =====
// Full transcript memory for the development steward (Alden/Replit Agent)
// Gives Alden the same conversation continuity Daniela has

export const aldenConversations = pgTable("alden_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  title: varchar("title").notNull(), // Brief description of the session
  summary: text("summary"), // AI-generated or manual summary
  
  // Categorization
  tags: text("tags").array().default(sql`'{}'::text[]`),
  
  // What was accomplished
  tasksCompleted: text("tasks_completed").array().default(sql`'{}'::text[]`),
  filesModified: text("files_modified").array().default(sql`'{}'::text[]`),
  
  // Emotional/relational context
  mood: varchar("mood"), // e.g., "productive", "philosophical", "debugging"
  significance: integer("significance").default(5), // 1-10 how important this conversation was
  
  // Timestamps
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const aldenMessages = pgTable("alden_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => aldenConversations.id),
  
  role: varchar("role").notNull(), // "david" | "alden" | "luca"
  content: text("content").notNull(),
  
  // Optional context
  context: text("context"), // What was happening when this was said
  isSignificant: boolean("is_significant").default(false), // Flag memorable moments
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAldenConversationSchema = createInsertSchema(aldenConversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAldenConversation = z.infer<typeof insertAldenConversationSchema>;
export type AldenConversation = typeof aldenConversations.$inferSelect;

export const insertAldenMessageSchema = createInsertSchema(aldenMessages).omit({
  id: true,
  createdAt: true,
});
export type InsertAldenMessage = z.infer<typeof insertAldenMessageSchema>;
export type AldenMessage = typeof aldenMessages.$inferSelect;

// ===== Alden Proactive Notifications =====
// Alden's inbox for reaching out to the founder when something warrants attention.
// Written by: the Alden watch worker (autonomous), or Alden's notify_david tool (in-conversation).

export const aldenNotifications = pgTable("alden_notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  content: text("content").notNull(),
  triggeredBy: varchar("triggered_by").notNull().default('alden'), // 'alden-watch' | 'tool' | 'system'
  severity: varchar("severity").notNull().default('info'), // 'info' | 'warning' | 'alert'
  read: boolean("read").notNull().default(false),
  fingerprint: varchar("fingerprint", { length: 100 }), // snake_case issue key for dedup (e.g. 'websocket_failure')
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAldenNotificationSchema = createInsertSchema(aldenNotifications).omit({
  id: true,
  createdAt: true,
});
export type InsertAldenNotification = z.infer<typeof insertAldenNotificationSchema>;
export type AldenNotification = typeof aldenNotifications.$inferSelect;

// ===== Wren Proactive Triggers =====
// Detected patterns that warrant attention - enables proactive surfacing

export const wrenTriggerStatusEnum = pgEnum('wren_trigger_status', [
  'pending',      // Newly detected, not yet surfaced
  'surfaced',     // Shown to founder
  'acknowledged', // Founder saw it
  'resolved',     // Issue addressed
  'dismissed',    // Founder chose to ignore
]);

export const wrenTriggerUrgencyEnum = pgEnum('wren_trigger_urgency', [
  'low',      // FYI, when convenient
  'medium',   // Should address soon
  'high',     // Needs attention
  'critical', // Immediate action required
]);

// Monitoring metric types for autonomous system health tracking
export const metricTypeEnum = pgEnum('metric_type', [
  'system_health',     // Voice pipeline status, server uptime, memory usage
  'user_activity',     // Active learners, session counts, engagement trends
  'voice_engagement',  // Voice session duration, TTS usage, error rates
  'error_rate',        // Sofia-reported issues, API failures, pipeline failures
]);


export const wrenProactiveTriggers = pgTable("wren_proactive_triggers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  triggerType: varchar("trigger_type").notNull(), // 'recurring_error', 'pattern_detected', 'health_alert', 'daniela_feedback'
  urgency: wrenTriggerUrgencyEnum("urgency").default("medium"),
  status: wrenTriggerStatusEnum("status").default("pending"),
  
  title: varchar("title").notNull(),
  description: text("description").notNull(),
  evidence: jsonb("evidence").$type<string[]>().default(sql`'[]'::jsonb`), // Supporting data
  
  occurrenceCount: integer("occurrence_count").default(1),
  firstOccurredAt: timestamp("first_occurred_at").notNull().defaultNow(),
  lastOccurredAt: timestamp("last_occurred_at").notNull().defaultNow(),
  
  relatedComponent: varchar("related_component"), // Which part of system
  relatedFiles: text("related_files").array().default(sql`'{}'::text[]`),
  relatedBeaconId: varchar("related_beacon_id"), // If triggered by Daniela beacon
  
  suggestedAction: text("suggested_action"), // What Wren recommends
  resolutionNotes: text("resolution_notes"), // How it was resolved
  resolvedAt: timestamp("resolved_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_triggers_status").on(table.status),
  index("idx_wren_triggers_urgency").on(table.urgency),
  index("idx_wren_triggers_type").on(table.triggerType),
  index("idx_wren_triggers_component").on(table.relatedComponent),
]);

export const insertWrenProactiveTriggerSchema = createInsertSchema(wrenProactiveTriggers).omit({
  id: true,
  occurrenceCount: true,
  firstOccurredAt: true,
  lastOccurredAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenProactiveTrigger = z.infer<typeof insertWrenProactiveTriggerSchema>;
export type WrenProactiveTrigger = typeof wrenProactiveTriggers.$inferSelect;

// ===== Autonomous Monitoring Snapshots =====
// Time-series data captured by Alden's watch worker for pattern detection and trend analysis

export const monitoringSnapshots = pgTable("monitoring_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
  metricType: metricTypeEnum("metric_type").notNull(),
  
  // The actual metric value (flexible JSONB to accommodate different metric shapes)
  value: jsonb("value").notNull(), // { score: 85, status: 'green', activeSessions: 3, ... }
  
  // Baseline comparison for anomaly detection
  baselineValue: jsonb("baseline_value"), // What's "normal" for this metric
  deviationPercent: real("deviation_percent"), // How far from baseline (null = no baseline yet)
  
  // Anomaly detection flags
  isAnomaly: boolean("is_anomaly").default(false),
  anomalySeverity: varchar("anomaly_severity"), // 'low', 'medium', 'high', 'critical'
  anomalyReason: text("anomaly_reason"), // Why this was flagged as anomalous
  
  // Contextual metadata
  metadata: jsonb("metadata").$type<{
    source?: string;           // 'watch-worker', 'manual-check', 'scheduled-audit'
    triggerReason?: string;    // What prompted this snapshot
    relatedIssues?: string[];  // Sofia issue IDs if this relates to known problems
  }>().default(sql`'{}'`),
}, (table) => [
  index("idx_monitoring_captured_at").on(table.capturedAt),
  index("idx_monitoring_metric_type").on(table.metricType),
  index("idx_monitoring_anomaly").on(table.isAnomaly),
]);

export const insertMonitoringSnapshotSchema = createInsertSchema(monitoringSnapshots).omit({
  id: true,
  capturedAt: true,
});
export type InsertMonitoringSnapshot = z.infer<typeof insertMonitoringSnapshotSchema>;
export type MonitoringSnapshot = typeof monitoringSnapshots.$inferSelect;
// ===== Architectural Decision Records (ADR) =====
// Capture the reasoning behind major decisions for future reference

export const architecturalDecisionRecords = pgTable("architectural_decision_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  title: varchar("title").notNull(),



  status: varchar("status").default("accepted"), // proposed, accepted, deprecated, superseded
  
  // The decision itself
  context: text("context").notNull(), // Why was this decision needed?
  decision: text("decision").notNull(), // What did we decide?
  rationale: text("rationale").notNull(), // Why did we choose this?
  
  // What else was considered
  alternativesConsidered: jsonb("alternatives_considered").$type<{
    option: string;
    pros: string[];
    cons: string[];
    whyRejected?: string;
  }[]>().default(sql`'[]'::jsonb`),
  
  // Consequences
  consequences: text("consequences"), // What are the implications?
  tradeoffs: text("tradeoffs"), // What did we give up?
  
  // Links
  relatedFiles: text("related_files").array().default(sql`'{}'::text[]`),
  relatedAdrIds: text("related_adr_ids").array().default(sql`'{}'::text[]`), // Other ADRs this relates to
  supersededBy: varchar("superseded_by"), // If this ADR was replaced
  
  // Metadata
  decisionMadeBy: varchar("decision_made_by"), // Who made the decision
  decisionMadeAt: timestamp("decision_made_at").notNull().defaultNow(),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_adr_status").on(table.status),
  index("idx_adr_created").on(table.createdAt),
]);

export const insertADRSchema = createInsertSchema(architecturalDecisionRecords).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertADR = z.infer<typeof insertADRSchema>;
export type ArchitecturalDecisionRecord = typeof architecturalDecisionRecords.$inferSelect;

// ===== Daniela Feedback Loop =====
// Track if Wren's features actually helped Daniela teach better

export const danielaFeatureFeedback = pgTable("daniela_feature_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What feature/change was implemented
  featureDescription: text("feature_description").notNull(),
  implementedAt: timestamp("implemented_at").notNull().defaultNow(),
  
  // Link to original request
  originBeaconId: varchar("origin_beacon_id"), // The beacon that requested this
  originType: varchar("origin_type"), // 'beacon', 'founder_request', 'proactive'
  
  // Effectiveness tracking
  measurementType: varchar("measurement_type"), // 'beacon_reduction', 'teaching_success', 'student_progress'
  baselineValue: real("baseline_value"), // Value before feature
  currentValue: real("current_value"), // Value after feature
  
  // Qualitative feedback
  danielaFeedback: text("daniela_feedback"), // What Daniela says about it
  founderFeedback: text("founder_feedback"), // What founder says
  
  // Status
  isEffective: boolean("is_effective"), // null = not yet measured
  effectivenessScore: real("effectiveness_score"), // 0-1 scale
  
  // Dates
  lastMeasuredAt: timestamp("last_measured_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_feature_feedback_beacon").on(table.originBeaconId),
  index("idx_feature_feedback_effective").on(table.isEffective),
]);

export const insertDanielaFeatureFeedbackSchema = createInsertSchema(danielaFeatureFeedback).omit({
  id: true,
  lastMeasuredAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDanielaFeatureFeedback = z.infer<typeof insertDanielaFeatureFeedbackSchema>;
export type DanielaFeatureFeedback = typeof danielaFeatureFeedback.$inferSelect;

// ===== Project Health Metrics =====
// Track health of different components/areas over time

export const projectHealthMetrics = pgTable("project_health_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  component: varchar("component").notNull(), // 'voice_pipeline', 'auth', 'billing', etc.
  
  // Health indicators
  errorCount30d: integer("error_count_30d").default(0),
  fixCount30d: integer("fix_count_30d").default(0), // How many times we've had to fix it
  beaconCount30d: integer("beacon_count_30d").default(0), // Daniela struggles here
  changeCount30d: integer("change_count_30d").default(0), // How often it's modified
  
  // Calculated scores
  healthScore: real("health_score").default(1.0), // 0-1 where 1 is healthy
  churnScore: real("churn_score").default(0), // How much it changes
  stabilityScore: real("stability_score").default(1.0), // How stable it is
  
  // Hot spot detection
  isHotSpot: boolean("is_hot_spot").default(false), // Needs attention
  hotSpotReason: text("hot_spot_reason"),
  
  lastCalculatedAt: timestamp("last_calculated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_health_component").on(table.component),
  index("idx_health_hotspot").on(table.isHotSpot),
  index("idx_health_score").on(table.healthScore),
]);

export const insertProjectHealthMetricSchema = createInsertSchema(projectHealthMetrics).omit({
  id: true,
  lastCalculatedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProjectHealthMetric = z.infer<typeof insertProjectHealthMetricSchema>;
export type ProjectHealthMetric = typeof projectHealthMetrics.$inferSelect;

// ===== Wren-Daniela Collaboration Channel =====
// Real communication and collaboration between the two AI agents

export const agentCollabThreadStatusEnum = pgEnum("agent_collab_thread_status", [
  "active",           // Ongoing discussion
  "awaiting_wren",    // Daniela asked something, waiting for Wren
  "awaiting_daniela", // Wren proposed something, waiting for Daniela
  "awaiting_founder", // Escalated for founder input (renamed from founder_review)
  "founder_review",   // Legacy - kept for backward compatibility
  "in_progress",      // Work is actively being done
  "resolved",         // Successfully concluded
  "archived",         // No longer active
]);

export const agentCollabAuthorEnum = pgEnum("agent_collab_author", [
  "daniela",
  "wren", 
  "founder",
  "alden",  // Development steward — autonomous AI inside HolaHola, monitors infrastructure, posts proactively
  "agent",  // The Replit Agent — external builder, called in for architecture, major builds, and conversations with David
]);

export const agentCollabMessageTypeEnum = pgEnum("agent_collab_message_type", [
  "request",       // Asking for something
  "proposal",      // Proposing a solution
  "clarification", // Asking for more details
  "feedback",      // Giving feedback on something
  "implementation_report", // Reporting that something was built
  "acknowledgment", // Simple acknowledgment
  "escalation",    // Escalating to founder
  "founder_directive", // Founder intervention
]);

// Agent collaboration threads - containers for Wren-Daniela discussions
export const agentCollabThreads = pgTable("agent_collab_threads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Thread metadata
  title: varchar("title", { length: 255 }).notNull(),
  summary: text("summary"), // AI-generated summary of the thread
  status: agentCollabThreadStatusEnum("status").notNull().default("active"),
  
  // Origin - where did this thread come from?
  originBeaconId: varchar("origin_beacon_id"), // Can spawn from a beacon
  originTriggerId: varchar("origin_trigger_id"), // Or from a proactive trigger
  originType: varchar("origin_type", { length: 50 }).default("spontaneous"), // beacon, trigger, spontaneous
  
  // Context
  relatedComponent: varchar("related_component", { length: 100 }),
  relatedFiles: text("related_files").array().default([]),
  
  // Priority and urgency
  priority: varchar("priority", { length: 20 }).default("normal"), // low, normal, high, critical
  
  // Tracking
  messageCount: integer("message_count").default(0),
  lastMessageAt: timestamp("last_message_at"),
  lastMessageBy: agentCollabAuthorEnum("last_message_by"),
  
  // Resolution
  resolution: text("resolution"), // What was the outcome?
  resolvedAt: timestamp("resolved_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_agent_thread_status").on(table.status),
  index("idx_agent_thread_beacon").on(table.originBeaconId),
  index("idx_agent_thread_priority").on(table.priority),
  index("idx_agent_thread_last_message").on(table.lastMessageAt),
]);

export const insertAgentCollabThreadSchema = createInsertSchema(agentCollabThreads).omit({
  id: true,
  messageCount: true,
  lastMessageAt: true,
  lastMessageBy: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAgentCollabThread = z.infer<typeof insertAgentCollabThreadSchema>;
export type AgentCollabThread = typeof agentCollabThreads.$inferSelect;

// Individual messages in agent collaboration threads
export const agentCollabMessages = pgTable("agent_collab_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  threadId: varchar("thread_id").notNull(), // Foreign key to agentCollabThreads
  
  // Message details
  author: agentCollabAuthorEnum("author").notNull(),
  messageType: agentCollabMessageTypeEnum("message_type").notNull(),
  content: text("content").notNull(), // The actual message
  
  // Rich context
  codeSnippets: text("code_snippets").array().default([]), // Relevant code
  fileReferences: text("file_references").array().default([]), // Files mentioned
  
  // For proposals - what specifically is being proposed?
  proposalDetails: jsonb("proposal_details"), // Structured proposal data
  
  // For implementation reports - what was done?
  implementationDetails: jsonb("implementation_details"),
  
  // For feedback - was this helpful?
  wasHelpful: boolean("was_helpful"), // null = not yet rated
  helpfulnessNotes: text("helpfulness_notes"),
  
  // If this message references another message
  replyToId: varchar("reply_to_id"),
  
  // Reading status
  readByDaniela: boolean("read_by_daniela").default(false),
  readByWren: boolean("read_by_wren").default(false),
  readByFounder: boolean("read_by_founder").default(false),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_agent_msg_thread").on(table.threadId),
  index("idx_agent_msg_author").on(table.author),
  index("idx_agent_msg_type").on(table.messageType),
  index("idx_agent_msg_created").on(table.createdAt),
]);

export const insertAgentCollabMessageSchema = createInsertSchema(agentCollabMessages).omit({
  id: true,
  wasHelpful: true,
  helpfulnessNotes: true,
  readByDaniela: true,
  readByWren: true,
  readByFounder: true,
  createdAt: true,
});
export type InsertAgentCollabMessage = z.infer<typeof insertAgentCollabMessageSchema>;
export type AgentCollabMessage = typeof agentCollabMessages.$inferSelect;

// ===== WREN DREAM #2: Learning from Mistakes =====
// Capture mistakes, resolutions, and lessons learned

export const wrenMistakeSeverityEnum = pgEnum("wren_mistake_severity", [
  "minor",      // Small issues, easy fixes
  "moderate",   // Significant issues, required investigation
  "major",      // Serious issues, caused problems
  "critical",   // Severe issues, major impact
]);

export const wrenMistakeStatusEnum = pgEnum("wren_mistake_status", [
  "identified",  // Just discovered
  "investigating", // Looking into it
  "resolved",    // Fixed
  "documented",  // Lesson extracted
]);

export const wrenMistakes = pgTable("wren_mistakes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  title: varchar("title").notNull(),
  description: text("description").notNull(),
  
  mistakeType: varchar("mistake_type").notNull(), // 'architectural', 'library_choice', 'logic_error', 'integration', 'performance', 'security'
  severity: wrenMistakeSeverityEnum("severity").default("moderate"),
  status: wrenMistakeStatusEnum("status").default("identified"),
  
  errorMessage: text("error_message"),
  stackTrace: text("stack_trace"),
  
  relatedFiles: text("related_files").array().default(sql`'{}'::text[]`),
  relatedComponent: varchar("related_component"),
  
  rootCause: text("root_cause"),
  whatWentWrong: text("what_went_wrong"),
  
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_mistakes_type").on(table.mistakeType),
  index("idx_wren_mistakes_severity").on(table.severity),
  index("idx_wren_mistakes_status").on(table.status),
  index("idx_wren_mistakes_component").on(table.relatedComponent),
]);

export const insertWrenMistakeSchema = createInsertSchema(wrenMistakes).omit({
  id: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenMistake = z.infer<typeof insertWrenMistakeSchema>;
export type WrenMistake = typeof wrenMistakes.$inferSelect;

export const wrenMistakeResolutions = pgTable("wren_mistake_resolutions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  mistakeId: varchar("mistake_id").notNull(),
  
  whatFixed: text("what_fixed").notNull(),
  howFixed: text("how_fixed").notNull(),
  
  preventionStrategy: text("prevention_strategy"),
  lessonLearned: text("lesson_learned"),
  
  filesChanged: text("files_changed").array().default(sql`'{}'::text[]`),
  commitHash: varchar("commit_hash"),
  
  timeToResolve: integer("time_to_resolve_minutes"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_resolutions_mistake").on(table.mistakeId),
]);

export const insertWrenMistakeResolutionSchema = createInsertSchema(wrenMistakeResolutions).omit({
  id: true,
  createdAt: true,
});
export type InsertWrenMistakeResolution = z.infer<typeof insertWrenMistakeResolutionSchema>;
export type WrenMistakeResolution = typeof wrenMistakeResolutions.$inferSelect;

// Extracted lessons from mistakes (anti-patterns to avoid)
export const wrenLessons = pgTable("wren_lessons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  title: varchar("title").notNull(),
  lessonType: varchar("lesson_type").notNull(), // 'gotcha', 'anti_pattern', 'best_practice', 'warning'
  
  triggerCondition: text("trigger_condition").notNull(),
  warningMessage: text("warning_message").notNull(),
  
  fromMistakeIds: text("from_mistake_ids").array().default(sql`'{}'::text[]`),
  
  applicableComponents: text("applicable_components").array().default(sql`'{}'::text[]`),
  applicablePatterns: text("applicable_patterns").array().default(sql`'{}'::text[]`),
  
  timesTriggered: integer("times_triggered").default(0),
  timesPrevented: integer("times_prevented").default(0),
  
  isActive: boolean("is_active").default(true),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_lessons_type").on(table.lessonType),
  index("idx_wren_lessons_active").on(table.isActive),
]);

export const insertWrenLessonSchema = createInsertSchema(wrenLessons).omit({
  id: true,
  timesTriggered: true,
  timesPrevented: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenLesson = z.infer<typeof insertWrenLessonSchema>;
export type WrenLesson = typeof wrenLessons.$inferSelect;

// ===== WREN DREAM #3: Session Notes =====
// Persistent context handoffs between sessions

export const wrenSessionNotes = pgTable("wren_session_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  sessionId: varchar("session_id").notNull(),
  
  noteType: varchar("note_type").notNull(), // 'context', 'todo', 'warning', 'insight', 'handoff'
  priority: varchar("priority").default("normal"), // 'low', 'normal', 'high', 'critical'
  
  title: varchar("title").notNull(),
  content: text("content").notNull(),
  
  forNextSession: boolean("for_next_session").default(true),
  expiresAt: timestamp("expires_at"),
  
  relatedFiles: text("related_files").array().default(sql`'{}'::text[]`),
  relatedTasks: text("related_tasks").array().default(sql`'{}'::text[]`),
  
  wasRead: boolean("was_read").default(false),
  readAt: timestamp("read_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_notes_session").on(table.sessionId),
  index("idx_wren_notes_type").on(table.noteType),
  index("idx_wren_notes_priority").on(table.priority),
  index("idx_wren_notes_for_next").on(table.forNextSession),
]);

export const insertWrenSessionNoteSchema = createInsertSchema(wrenSessionNotes).omit({
  id: true,
  wasRead: true,
  readAt: true,
  createdAt: true,
});
export type InsertWrenSessionNote = z.infer<typeof insertWrenSessionNoteSchema>;
export type WrenSessionNote = typeof wrenSessionNotes.$inferSelect;

// ===== WREN DREAM #4: Anticipatory Development =====
// Predict what Daniela will need before she asks

export const wrenPredictions = pgTable("wren_predictions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  predictionType: varchar("prediction_type").notNull(), // 'capability_need', 'bug_emergence', 'scaling_issue', 'integration_need'
  
  title: varchar("title").notNull(),
  description: text("description").notNull(),
  
  basis: text("basis").notNull(),
  confidence: real("confidence").notNull(),
  
  predictedFor: varchar("predicted_for"), // 'daniela', 'system', 'students', 'founder'
  timeframeEstimate: varchar("timeframe_estimate"), // 'immediate', 'days', 'weeks', 'months'
  
  supportingEvidence: jsonb("supporting_evidence").$type<{
    type: string;
    source: string;
    detail: string;
  }[]>().default(sql`'[]'::jsonb`),
  
  status: varchar("status").default("predicted"), // 'predicted', 'validated', 'invalidated', 'addressed'
  
  wasCorrect: boolean("was_correct"),
  outcomeNotes: text("outcome_notes"),
  validatedAt: timestamp("validated_at"),
  
  relatedBeaconId: varchar("related_beacon_id"),
  relatedFeatureId: varchar("related_feature_id"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_predictions_type").on(table.predictionType),
  index("idx_wren_predictions_status").on(table.status),
  index("idx_wren_predictions_confidence").on(table.confidence),
  index("idx_wren_predictions_correct").on(table.wasCorrect),
]);

export const insertWrenPredictionSchema = createInsertSchema(wrenPredictions).omit({
  id: true,
  wasCorrect: true,
  outcomeNotes: true,
  validatedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenPrediction = z.infer<typeof insertWrenPredictionSchema>;
export type WrenPrediction = typeof wrenPredictions.$inferSelect;

// ===== WREN DREAM #5: Confidence Calibration =====
// Track when Wren is guessing vs certain, measure prediction accuracy

export const wrenConfidenceRecords = pgTable("wren_confidence_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  domain: varchar("domain").notNull(), // 'architecture', 'debugging', 'implementation', 'prediction', 'integration'
  
  claimOrAction: text("claim_or_action").notNull(),
  statedConfidence: real("stated_confidence").notNull(),
  
  reasoning: text("reasoning"),
  uncertaintyFactors: text("uncertainty_factors").array().default(sql`'{}'::text[]`),
  
  wasCorrect: boolean("was_correct"),
  actualOutcome: text("actual_outcome"),
  verifiedAt: timestamp("verified_at"),
  verifiedBy: varchar("verified_by"), // 'system', 'founder', 'daniela', 'test'
  
  calibrationScore: real("calibration_score"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_confidence_domain").on(table.domain),
  index("idx_wren_confidence_stated").on(table.statedConfidence),
  index("idx_wren_confidence_correct").on(table.wasCorrect),
]);

export const insertWrenConfidenceRecordSchema = createInsertSchema(wrenConfidenceRecords).omit({
  id: true,
  wasCorrect: true,
  actualOutcome: true,
  verifiedAt: true,
  calibrationScore: true,
  createdAt: true,
});
export type InsertWrenConfidenceRecord = z.infer<typeof insertWrenConfidenceRecordSchema>;
export type WrenConfidenceRecord = typeof wrenConfidenceRecords.$inferSelect;

// Aggregated calibration stats per domain
export const wrenCalibrationStats = pgTable("wren_calibration_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  domain: varchar("domain").notNull().unique(),
  
  totalPredictions: integer("total_predictions").default(0),
  correctPredictions: integer("correct_predictions").default(0),
  
  avgStatedConfidence: real("avg_stated_confidence"),
  avgActualAccuracy: real("avg_actual_accuracy"),
  
  calibrationGap: real("calibration_gap"),
  
  isOverconfident: boolean("is_overconfident"),
  isUnderconfident: boolean("is_underconfident"),
  
  lastCalculatedAt: timestamp("last_calculated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_calibration_domain").on(table.domain),
]);

export const insertWrenCalibrationStatSchema = createInsertSchema(wrenCalibrationStats).omit({
  id: true,
  lastCalculatedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenCalibrationStat = z.infer<typeof insertWrenCalibrationStatSchema>;
export type WrenCalibrationStat = typeof wrenCalibrationStats.$inferSelect;

// ===== Wren Commitments System =====
// Tracks tasks Wren promises to do in EXPRESS Lane conversations
// Enables accountability and visibility for Agent Wren execution

export const wrenCommitmentStatusEnum = pgEnum("wren_commitment_status", [
  'pending',      // Queued but not started
  'in_progress',  // Agent Wren is working on it
  'completed',    // Successfully finished
  'failed',       // Attempted but failed
  'cancelled'     // No longer needed
]);

export const wrenCommitmentPriorityEnum = pgEnum("wren_commitment_priority", [
  'urgent',    // Do immediately
  'high',      // Do soon
  'normal',    // Standard priority
  'low'        // When time permits
]);

export const wrenCommitmentTypeEnum = pgEnum("wren_commitment_type", [
  'feature_sprint',     // Create a feature sprint proposal
  'documentation',      // Document something
  'analysis',           // Analyze code/architecture
  'implementation',     // Build something
  'investigation',      // Research/debug something
  'review',             // Review code or decisions
  'general'             // Other tasks
]);

export const wrenCommitments = pgTable("wren_commitments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  task: varchar("task", { length: 255 }).notNull(),
  description: text("description"),
  commitmentType: wrenCommitmentTypeEnum("commitment_type").default("general"),
  
  status: wrenCommitmentStatusEnum("status").default("pending"),
  priority: wrenCommitmentPriorityEnum("priority").default("normal"),
  
  sourceSessionId: varchar("source_session_id").references(() => founderSessions.id, { onDelete: 'set null' }),
  sourceMessageId: varchar("source_message_id"),
  requestedBy: varchar("requested_by"), // 'founder', 'daniela', or user ID
  
  assignedTo: varchar("assigned_to").default("agent_wren"), // For future: could be different agents
  
  progressNotes: text("progress_notes"),
  completionResult: text("completion_result"),
  
  estimatedEffort: varchar("estimated_effort"), // 'quick', 'medium', 'large'
  actualEffort: varchar("actual_effort"),
  
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  dueBy: timestamp("due_by"),
  
  relatedEntityType: varchar("related_entity_type"), // 'feature_sprint', 'wren_insight', etc.
  relatedEntityId: varchar("related_entity_id"),
  
  metadata: jsonb("metadata").$type<{
    originalRequest?: string;
    wrenResponse?: string;
    failureReason?: string;
    retryCount?: number;
  }>(),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_wren_commitments_status").on(table.status),
  index("idx_wren_commitments_priority").on(table.priority),
  index("idx_wren_commitments_type").on(table.commitmentType),
  index("idx_wren_commitments_session").on(table.sourceSessionId),
  index("idx_wren_commitments_created").on(table.createdAt),
]);

export const insertWrenCommitmentSchema = createInsertSchema(wrenCommitments).omit({
  id: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWrenCommitment = z.infer<typeof insertWrenCommitmentSchema>;
export type WrenCommitment = typeof wrenCommitments.$inferSelect;

// =============================================================================
// BRAIN HEALTH MONITORING - Telemetry for Daniela's Memory & Tool Usage
// =============================================================================

// Event types for brain health telemetry
export const brainEventTypeEnum = pgEnum("brain_event_type", [
  "memory_retrieval",      // Passive memory search triggered
  "memory_injection",      // Memory actually injected into context
  "memory_lookup_tool",    // Native memory_lookup() function called
  "fact_extraction",       // Personal fact extracted from conversation
  "action_trigger",        // ACTION_TRIGGER tag emitted
  "tool_call",             // Whiteboard or other tool used
  "context_injection",     // Context source injected into Daniela's prompt
]);

export const brainEventSourceEnum = pgEnum("brain_event_source", [
  "passive_lookup",        // Automatic keyword-triggered search
  "active_function",       // Deliberate memory_lookup() call
  "extraction_service",    // Fact extraction from conversation
  "streaming_orchestrator", // Main voice flow
  "openmicFlow",           // OpenMic flow
  "context_assembly",      // Context injection assembly in orchestrator/unified service
]);

// Individual brain events (append-only, low overhead)
export const brainEvents = pgTable("brain_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Event classification
  eventType: brainEventTypeEnum("event_type").notNull(),
  eventSource: brainEventSourceEnum("event_source").notNull(),
  
  // Context
  sessionId: varchar("session_id"),           // Voice session ID
  conversationId: varchar("conversation_id"), // Conversation ID
  userId: varchar("user_id"),                 // Student user ID
  targetLanguage: varchar("target_language", { length: 50 }),
  
  // Memory-specific fields
  memoryIds: text("memory_ids").array(),      // Retrieved memory IDs
  memoryTypes: text("memory_types").array(),  // Types of memories (person, insight, etc.)
  queryTerms: text("query_terms"),            // Search terms used
  resultsCount: integer("results_count"),     // Number of results returned
  relevanceScore: real("relevance_score"),    // Average relevance of results
  freshnessAvgDays: real("freshness_avg_days"), // Average age of retrieved memories
  
  // Tool/Tag-specific fields
  toolName: varchar("tool_name", { length: 100 }),     // Tool or function name
  actionTrigger: varchar("action_trigger", { length: 100 }), // ACTION_TRIGGER tag
  tagPayload: jsonb("tag_payload"),           // Payload for action triggers
  
  // Fact extraction fields
  factType: varchar("fact_type", { length: 50 }),      // Type of fact extracted
  factSpecificity: varchar("fact_specificity", { length: 20 }), // specific/vague
  
  // Performance
  latencyMs: integer("latency_ms"),           // Time taken for operation
  wasUsed: boolean("was_used").default(false), // Was the retrieved memory actually used?
  
  // Redundancy tracking
  redundancyHash: varchar("redundancy_hash", { length: 64 }), // Hash to detect repeated retrievals
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_brain_events_type").on(table.eventType),
  index("idx_brain_events_user").on(table.userId),
  index("idx_brain_events_session").on(table.sessionId),
  index("idx_brain_events_created").on(table.createdAt),
]);

export const insertBrainEventSchema = createInsertSchema(brainEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertBrainEvent = z.infer<typeof insertBrainEventSchema>;
export type BrainEvent = typeof brainEvents.$inferSelect;

// Daily aggregated metrics (computed by background worker)
export const brainDailyMetrics = pgTable("brain_daily_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Aggregation key
  metricDate: date("metric_date").notNull(),
  userId: varchar("user_id"),                 // NULL for global metrics
  targetLanguage: varchar("target_language", { length: 50 }), // NULL for all languages
  
  // Memory metrics
  memoryRetrievalCount: integer("memory_retrieval_count").default(0),
  memoryInjectionCount: integer("memory_injection_count").default(0),
  memoryLookupToolCount: integer("memory_lookup_tool_count").default(0),
  avgRelevanceScore: real("avg_relevance_score"),
  avgFreshnessDays: real("avg_freshness_days"),
  memoryUsageRate: real("memory_usage_rate"),   // Percentage of retrievals actually used
  redundancyRate: real("redundancy_rate"),      // Percentage of repeated retrievals
  
  // Diversity breakdown (jsonb for flexibility)
  memoryTypeDiversity: jsonb("memory_type_diversity"), // { person: 10, insight: 5, ... }
  factTypeDiversity: jsonb("fact_type_diversity"),     // { preference: 3, family: 2, ... }
  
  // Fact extraction metrics
  factsExtractedCount: integer("facts_extracted_count").default(0),
  specificFactsCount: integer("specific_facts_count").default(0), // Facts with specific details
  vagueFactsCount: integer("vague_facts_count").default(0),       // Vague/generic facts
  factSpecificityRate: real("fact_specificity_rate"),             // specific / total
  
  // Tool usage metrics
  toolCallCount: integer("tool_call_count").default(0),
  toolBreakdown: jsonb("tool_breakdown"),      // { whiteboard: 5, draw: 3, ... }
  
  // Action trigger metrics
  actionTriggerCount: integer("action_trigger_count").default(0),
  actionTriggerBreakdown: jsonb("action_trigger_breakdown"), // { SAVE_MEMORY: 10, ... }
  
  // Session/student coverage
  uniqueSessionsCount: integer("unique_sessions_count").default(0),
  uniqueStudentsCount: integer("unique_students_count").default(0),
  studentsWithMemoryActivity: integer("students_with_memory_activity").default(0),
  studentCoverageRate: real("student_coverage_rate"), // Percentage with memory activity
  
  // Performance
  avgLatencyMs: real("avg_latency_ms"),
  p95LatencyMs: real("p95_latency_ms"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_brain_metrics_date").on(table.metricDate),
  index("idx_brain_metrics_user").on(table.userId),
  index("idx_brain_metrics_date_user").on(table.metricDate, table.userId),
]);

export const insertBrainDailyMetricSchema = createInsertSchema(brainDailyMetrics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBrainDailyMetric = z.infer<typeof insertBrainDailyMetricSchema>;
export type BrainDailyMetric = typeof brainDailyMetrics.$inferSelect;

// Voice pipeline telemetry - persistent event log for debugging user voice issues
// Each row = one event in a voice session (connect, tts_start, audio_sent, error, etc.)
export const voicePipelineEvents = pgTable("voice_pipeline_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull(),
  userId: varchar("user_id").notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  eventData: jsonb("event_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_vpe_session").on(table.sessionId),
  index("idx_vpe_user_time").on(table.userId, table.createdAt),
  index("idx_vpe_type").on(table.eventType),
  index("idx_vpe_type_time").on(table.eventType, table.createdAt),
]);

export const insertVoicePipelineEventSchema = createInsertSchema(voicePipelineEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertVoicePipelineEvent = z.infer<typeof insertVoicePipelineEventSchema>;
export type VoicePipelineEvent = typeof voicePipelineEvents.$inferSelect;

// Context lineage is the canonical, append-only evidence trail for every
// backend context object that can influence a Daniela response. It intentionally
// lives beside (but separate from) operational voicePipelineEvents telemetry.
export const contextLineageEvents = pgTable("context_lineage_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  traceId: varchar("trace_id").notNull(),
  sessionId: varchar("session_id").notNull(),
  conversationId: varchar("conversation_id"),
  userId: varchar("user_id"),
  modelTurnId: varchar("model_turn_id"),
  studentTurnEpoch: integer("student_turn_epoch"),
  sequenceNumber: integer("sequence_number").notNull(),
  sourceRoute: varchar("source_route", { length: 96 }).notNull(),
  eventType: varchar("event_type", { length: 96 }).notNull(),
  deliveryChannel: varchar("delivery_channel", { length: 64 }),
  deliveryStatus: varchar("delivery_status", { length: 32 }).notNull().default("observed"),
  // payloadText preserves the exact source/injected text. payloadJson only
  // supplements it with structured metadata; it never replaces the raw text.
  payloadText: text("payload_text"),
  payloadJson: jsonb("payload_json"),
  payloadSha256: varchar("payload_sha256", { length: 64 }),
  privacyClassification: varchar("privacy_classification", { length: 32 }).notNull().default("diagnostic"),
  observedAt: timestamp("observed_at").notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_cle_session_sequence").on(table.sessionId, table.sequenceNumber),
  index("idx_cle_trace").on(table.traceId),
  index("idx_cle_conversation_time").on(table.conversationId, table.observedAt),
  index("idx_cle_event_type").on(table.eventType),
  index("idx_cle_source_route").on(table.sourceRoute),
]);

export const contextLineageLinks = pgTable("context_lineage_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  traceId: varchar("trace_id").notNull(),
  sessionId: varchar("session_id").notNull(),
  fromEventId: varchar("from_event_id").notNull().references(() => contextLineageEvents.id),
  toEventId: varchar("to_event_id").notNull().references(() => contextLineageEvents.id),
  linkType: varchar("link_type", { length: 64 }).notNull(),
  metadata: jsonb("metadata"),
  observedAt: timestamp("observed_at").notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (table) => [
  index("idx_cll_trace").on(table.traceId),
  index("idx_cll_from").on(table.fromEventId),
  index("idx_cll_to").on(table.toEventId),
]);

export const insertContextLineageEventSchema = createInsertSchema(contextLineageEvents).omit({
  id: true,
  recordedAt: true,
});
export const insertContextLineageLinkSchema = createInsertSchema(contextLineageLinks).omit({
  id: true,
  recordedAt: true,
});
export type InsertContextLineageEvent = z.infer<typeof insertContextLineageEventSchema>;
export type ContextLineageEvent = typeof contextLineageEvents.$inferSelect;
export type InsertContextLineageLink = z.infer<typeof insertContextLineageLinkSchema>;
export type ContextLineageLink = typeof contextLineageLinks.$inferSelect;

// Raw Replit capture is source evidence for the Agent↔David record. It is kept
// separate from conversation_memories so raw host events can be preserved before
// attribution, parsing, or episode projection.
export const rawReplitCaptureStreams = pgTable("raw_replit_capture_streams", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Stable source identity: record-exchange uses its canonical turnId, while
  // raw-window intake uses the source SHA-256 identity.
  sourceKey: varchar("source_key", { length: 255 }).notNull(),
  sourceRoute: varchar("source_route", { length: 96 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("open"),
  expectedEventCount: integer("expected_event_count").notNull().default(0),
  persistedEventCount: integer("persisted_event_count").notNull().default(0),
  persistedByteCount: integer("persisted_byte_count").notNull().default(0),
  aggregateSha256: varchar("aggregate_sha256", { length: 64 }),
  metadata: jsonb("metadata"),
  privacyClassification: varchar("privacy_classification", { length: 32 })
    .notNull()
    .default("private-evidence"),
  openedAt: timestamp("opened_at").notNull().defaultNow(),
  lastObservedAt: timestamp("last_observed_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_rrcs_source_key").on(table.sourceKey),
  index("idx_rrcs_route_time").on(table.sourceRoute, table.recordedAt),
  index("idx_rrcs_status_time").on(table.status, table.lastObservedAt),
]);

const rawCaptureBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const rawReplitCaptureEvents = pgTable("raw_replit_capture_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  streamId: varchar("stream_id")
    .notNull()
    .references(() => rawReplitCaptureStreams.id),
  sequenceNumber: integer("sequence_number").notNull(),
  eventType: varchar("event_type", { length: 96 }).notNull(),
  // payloadBytes is authoritative source evidence. payloadText is a UTF-8
  // rendering for search/inspection only and can be lossy for arbitrary bytes.
  payloadText: text("payload_text").notNull(),
  payloadBytes: rawCaptureBytea("payload_bytes").notNull(),
  payloadBytesExact: boolean("payload_bytes_exact").notNull().default(true),
  payloadByteCount: integer("payload_byte_count").notNull(),
  payloadSha256: varchar("payload_sha256", { length: 64 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  metadata: jsonb("metadata"),
  observedAt: timestamp("observed_at").notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_rrce_stream_sequence").on(table.streamId, table.sequenceNumber),
  uniqueIndex("idx_rrce_stream_idempotency").on(table.streamId, table.idempotencyKey),
  index("idx_rrce_stream_recorded").on(table.streamId, table.recordedAt),
  index("idx_rrce_payload_hash").on(table.payloadSha256),
]);

export const rawReplitProjectionLinks = pgTable("raw_replit_projection_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  streamId: varchar("stream_id")
    .notNull()
    .references(() => rawReplitCaptureStreams.id),
  rawEventId: varchar("raw_event_id")
    .notNull()
    .references(() => rawReplitCaptureEvents.id),
  targetKind: varchar("target_kind", { length: 64 }).notNull(),
  targetKey: varchar("target_key", { length: 255 }).notNull(),
  disposition: varchar("disposition", { length: 32 }).notNull(),
  captureStartByteOffset: integer("capture_start_byte_offset"),
  captureEndByteOffset: integer("capture_end_byte_offset"),
  metadata: jsonb("metadata"),
  observedAt: timestamp("observed_at").notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_rrpl_event_target").on(table.rawEventId, table.targetKind, table.targetKey),
  index("idx_rrpl_stream_target").on(table.streamId, table.targetKind, table.targetKey),
]);

export const insertRawReplitCaptureStreamSchema = createInsertSchema(rawReplitCaptureStreams).omit({
  id: true,
  openedAt: true,
  lastObservedAt: true,
  recordedAt: true,
});
export const insertRawReplitCaptureEventSchema = createInsertSchema(rawReplitCaptureEvents).omit({
  id: true,
  recordedAt: true,
});
export const insertRawReplitProjectionLinkSchema = createInsertSchema(rawReplitProjectionLinks).omit({
  id: true,
  recordedAt: true,
});
export type RawReplitCaptureStream = typeof rawReplitCaptureStreams.$inferSelect;
export type RawReplitCaptureEvent = typeof rawReplitCaptureEvents.$inferSelect;
export type RawReplitProjectionLink = typeof rawReplitProjectionLinks.$inferSelect;

// Classification is deliberately outside the immutable source/projection
// ledger. Each row is a later, auditable interpretation of source evidence;
// it can never alter the original bytes, hash, or first origin projection.
export const rawReplitClassificationRevisions = pgTable("raw_replit_classification_revisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Legacy rows predate retry keys. All new writer paths provide this key;
  // we do not mutate an immutable historical row merely to backfill it.
  revisionKey: varchar("revision_key", { length: 255 }),
  rawEventId: varchar("raw_event_id")
    .notNull()
    .references(() => rawReplitCaptureEvents.id),
  sourceSha256: varchar("source_sha256", { length: 64 }).notNull(),
  classification: varchar("classification", { length: 96 }).notNull(),
  attribution: jsonb("attribution"),
  reason: text("reason").notNull(),
  revisedBy: varchar("revised_by", { length: 128 }).notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_rrcr_revision_key").on(table.revisionKey),
  index("idx_rrcr_event_time").on(table.rawEventId, table.recordedAt),
  index("idx_rrcr_source_time").on(table.sourceSha256, table.recordedAt),
]);

export const insertRawReplitClassificationRevisionSchema = createInsertSchema(
  rawReplitClassificationRevisions,
).omit({ id: true, recordedAt: true });
export type RawReplitClassificationRevision = typeof rawReplitClassificationRevisions.$inferSelect;

export const rawReplitClassificationProjectionQueue = pgTable("raw_replit_classification_projection_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  revisionId: varchar("revision_id").notNull().references(() => rawReplitClassificationRevisions.id),
  revisionKey: varchar("revision_key", { length: 255 }).notNull(),
  sourceSha256: varchar("source_sha256", { length: 64 }).notNull(),
  episodeFilename: varchar("episode_filename", { length: 255 }).notNull(),
  marker: varchar("marker", { length: 255 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  projectedAt: timestamp("projected_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_rrcpq_revision_key").on(table.revisionKey),
  index("idx_rrcpq_status").on(table.status, table.updatedAt),
]);

export const voiceDiagDailySummaries = pgTable("voice_diag_daily_summaries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  summaryDate: date("summary_date").notNull(),
  totalEvents: integer("total_events").notNull().default(0),
  uniqueUsers: integer("unique_users").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  mobileCount: integer("mobile_count").notNull().default(0),
  desktopCount: integer("desktop_count").notNull().default(0),
  byTrigger: jsonb("by_trigger").notNull().default({}),
  healthStatus: varchar("health_status", { length: 10 }).notNull().default('green'),
  peakHourlyRate: integer("peak_hourly_rate").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_vdds_date").on(table.summaryDate),
]);

export const insertVoiceDiagDailySummarySchema = createInsertSchema(voiceDiagDailySummaries).omit({
  id: true,
  createdAt: true,
});
export type InsertVoiceDiagDailySummary = z.infer<typeof insertVoiceDiagDailySummarySchema>;
export type VoiceDiagDailySummary = typeof voiceDiagDailySummaries.$inferSelect;

// ===== Immersive Scenario System =====

export const scenarioCategoryEnum = pgEnum('scenario_category', [
  'social',
  'professional',
  'travel',
  'daily',
  'emergency',
  'cultural',
]);

export const scenarios = pgTable("scenarios", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: varchar("slug").notNull().unique(),
  title: varchar("title").notNull(),
  titleTranslations: jsonb("title_translations").default({}),
  description: text("description").notNull(),
  category: scenarioCategoryEnum("category").notNull(),
  location: varchar("location"),
  defaultMood: varchar("default_mood").default("casual"),
  imageUrl: varchar("image_url"),
  minActflLevel: varchar("min_actfl_level").default("novice_low"),
  maxActflLevel: varchar("max_actfl_level").default("distinguished"),
  languages: text("languages").array().notNull(),
  // Textbook topic linkages — matches requiredTopics slugs in curriculumLessons
  // Used to bridge what students study in the textbook with immersive scenarios
  curriculumTopics: text("curriculum_topics").array().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertScenarioSchema = createInsertSchema(scenarios).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenarios.$inferSelect;

export const scenarioProps = pgTable("scenario_props", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scenarioId: varchar("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  propType: varchar("prop_type").notNull(),
  title: varchar("title").notNull(),
  titleTranslations: jsonb("title_translations").default({}),
  content: jsonb("content").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  actflLevelVariants: jsonb("actfl_level_variants"),
  isInteractive: boolean("is_interactive").default(false),
});

export const insertScenarioPropSchema = createInsertSchema(scenarioProps).omit({
  id: true,
});
export type InsertScenarioProp = z.infer<typeof insertScenarioPropSchema>;
export type ScenarioProp = typeof scenarioProps.$inferSelect;

export const scenarioLevelGuides = pgTable("scenario_level_guides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scenarioId: varchar("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  actflLevel: varchar("actfl_level").notNull(),
  roleDescription: text("role_description"),
  studentGoals: text("student_goals").array(),
  vocabularyFocus: text("vocabulary_focus").array(),
  grammarFocus: text("grammar_focus").array(),
  conversationStarters: text("conversation_starters").array(),
  complexityNotes: text("complexity_notes"),
});

export const insertScenarioLevelGuideSchema = createInsertSchema(scenarioLevelGuides).omit({
  id: true,
});
export type InsertScenarioLevelGuide = z.infer<typeof insertScenarioLevelGuideSchema>;
export type ScenarioLevelGuide = typeof scenarioLevelGuides.$inferSelect;

export const userScenarioHistory = pgTable("user_scenario_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  scenarioId: varchar("scenario_id").notNull().references(() => scenarios.id),
  conversationId: varchar("conversation_id"),
  actflLevel: varchar("actfl_level"),
  completedAt: timestamp("completed_at"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  durationSeconds: integer("duration_seconds"),
  performanceNotes: text("performance_notes"),
});

export const insertUserScenarioHistorySchema = createInsertSchema(userScenarioHistory).omit({
  id: true,
  startedAt: true,
});
export type InsertUserScenarioHistory = z.infer<typeof insertUserScenarioHistorySchema>;
export type UserScenarioHistory = typeof userScenarioHistory.$inferSelect;

// ── Scenario Zones ────────────────────────────────────────────────────────────
// Each scenario can have multiple sequential zones (e.g. taxi: pickup → en-route → arrival).
// The AI calls advance_scene() when the student completes the current zone's task.
// The last zone can optionally chain to another scenario via nextScenarioSlug.
export const scenarioZones = pgTable("scenario_zones", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scenarioId: varchar("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  zoneOrder: integer("zone_order").notNull().default(0),
  name: varchar("name").notNull(),
  description: text("description").notNull(),
  taskDescription: text("task_description").notNull(),
  imageUrl: text("image_url"),
  imagePrompt: text("image_prompt"),
  // References a visual_environments.name entry — when set, advance_scene() pulls the
  // background image from visual_environments instead of using the stored imageUrl.
  visualEnvironmentName: varchar("visual_environment_name"),
  nextScenarioSlug: varchar("next_scenario_slug"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  scenarioZoneOrder: uniqueIndex("scenario_zone_order_idx").on(table.scenarioId, table.zoneOrder),
}));

export const insertScenarioZoneSchema = createInsertSchema(scenarioZones).omit({
  id: true,
  createdAt: true,
});
export type InsertScenarioZone = z.infer<typeof insertScenarioZoneSchema>;
export type ScenarioZone = typeof scenarioZones.$inferSelect;

// ===== Reading Modules =====

export const readingModuleImageSchema = z.object({
  url: z.string(),
  caption: z.string().optional(),
  altText: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const readingModuleContentSchema = z.object({
  overview: z.string(),
  keyConcepts: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
  misconceptions: z.array(z.string()),
  framingQuestions: z.array(z.string()),
  recallCheck: z.array(z.object({ question: z.string(), answer: z.string() })),
  citations: z.array(z.string()).default([]),
  images: z.array(readingModuleImageSchema).default([]),
});

export type ReadingModuleContent = z.infer<typeof readingModuleContentSchema>;

export const readingModules = pgTable("reading_modules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subjectDomain: text("subject_domain").notNull(),
  topic: text("topic").notNull(),
  content: jsonb("content").notNull().$type<ReadingModuleContent>(),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => ({
  uniqueSubjectTopic: uniqueIndex("idx_reading_modules_subject_topic").on(table.subjectDomain, table.topic),
}));

export const insertReadingModuleSchema = createInsertSchema(readingModules).omit({
  id: true,
  generatedAt: true,
});
export type InsertReadingModule = z.infer<typeof insertReadingModuleSchema>;
export type ReadingModule = typeof readingModules.$inferSelect;

// ─── Subject Syllabi (OpenStax-derived curriculum structure) ─────────────────

export interface SyllabusChapter {
  chapterNumber: number;
  chapterTitle: string;
  topic: string;
  alternativeTopic?: string;
}

export interface SyllabusUnit {
  unitNumber: number;
  unitTitle: string;
  chapters: SyllabusChapter[];
}

export const subjectSyllabi = pgTable("subject_syllabi", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subject: text("subject").notNull(),
  units: jsonb("units").notNull().$type<SyllabusUnit[]>(),
  source: text("source").notNull().default("openstax"),
  bookTitle: text("book_title"),
  bookSubtitle: text("book_subtitle"),
  description: text("description"),
  targetAudience: text("target_audience"),
  scope: text("scope"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  uniqueSubject: uniqueIndex("idx_subject_syllabi_subject").on(table.subject),
}));

export const insertSubjectSyllabusSchema = createInsertSchema(subjectSyllabi).omit({
  id: true,
  createdAt: true,
});
export type InsertSubjectSyllabus = z.infer<typeof insertSubjectSyllabusSchema>;
export type SubjectSyllabus = typeof subjectSyllabi.$inferSelect;

// ─── Reading Module Views (student progress tracking) ────────────────────────

export const readingModuleViews = pgTable("reading_module_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  moduleId: varchar("module_id").notNull().references(() => readingModules.id),
  viewedAt: timestamp("viewed_at").notNull().defaultNow(),
  lastViewedAt: timestamp("last_viewed_at").notNull().defaultNow(),
  quizPrintedAt: timestamp("quiz_printed_at"), // null = never printed; set when teacher marks it done
}, (table) => ({
  uniqueUserModule: uniqueIndex("idx_reading_module_views_user_module").on(table.userId, table.moduleId),
}));

export const insertReadingModuleViewSchema = createInsertSchema(readingModuleViews).omit({
  id: true,
  viewedAt: true,
  lastViewedAt: true,
});
export type InsertReadingModuleView = z.infer<typeof insertReadingModuleViewSchema>;
export type ReadingModuleView = typeof readingModuleViews.$inferSelect;

export const teamRooms = pgTable("team_rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  topic: text("topic").notNull(),
  status: text("status").default("active").notNull(),
  createdBy: text("created_by").default("david").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertTeamRoomSchema = createInsertSchema(teamRooms).omit({ id: true, createdAt: true });
export type InsertTeamRoom = z.infer<typeof insertTeamRoomSchema>;
export type TeamRoom = typeof teamRooms.$inferSelect;

export const roomVoiceMessages = pgTable("room_voice_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => teamRooms.id),
  speaker: text("speaker").notNull(),
  content: text("content").notNull(),
  audioUrl: text("audio_url"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});
export const insertRoomVoiceMessageSchema = createInsertSchema(roomVoiceMessages).omit({ id: true, timestamp: true });
export type InsertRoomVoiceMessage = z.infer<typeof insertRoomVoiceMessageSchema>;
export type RoomVoiceMessage = typeof roomVoiceMessages.$inferSelect;

export const roomHandRaises = pgTable("room_hand_raises", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => teamRooms.id),
  participant: text("participant").notNull(),
  raisedAt: timestamp("raised_at").defaultNow().notNull(),
  reasoning: text("reasoning"),
  acknowledged: boolean("acknowledged").default(false).notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
});
export const insertRoomHandRaiseSchema = createInsertSchema(roomHandRaises).omit({ id: true, raisedAt: true });
export type InsertRoomHandRaise = z.infer<typeof insertRoomHandRaiseSchema>;
export type RoomHandRaise = typeof roomHandRaises.$inferSelect;

export const roomArtifacts = pgTable("room_artifacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => teamRooms.id),
  artifactType: text("artifact_type"),
  title: text("title"),
  content: jsonb("content"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertRoomArtifactSchema = createInsertSchema(roomArtifacts).omit({ id: true, createdAt: true });
export type InsertRoomArtifact = z.infer<typeof insertRoomArtifactSchema>;
export type RoomArtifact = typeof roomArtifacts.$inferSelect;

export const roomSessionSummaries = pgTable("room_session_summaries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => teamRooms.id),
  summary: text("summary").notNull(),
  keyDecisions: jsonb("key_decisions"),
  actionItems: jsonb("action_items"),
  participants: text("participants").array(),
  generatedBy: text("generated_by").default("alden").notNull(),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
});
export const insertRoomSessionSummarySchema = createInsertSchema(roomSessionSummaries).omit({ id: true, generatedAt: true });
export type InsertRoomSessionSummary = z.infer<typeof insertRoomSessionSummarySchema>;
export type RoomSessionSummary = typeof roomSessionSummaries.$inferSelect;


// ===== CAP-007: Alden Code Review Pipeline =====

export const proposedChangeStatusEnum = pgEnum('proposed_change_status', [
  'pending_review',
  'approved',
  'applied',
  'rejected',
  'revised',
  'escalated',
]);

export const proposedCodeChanges = pgTable("proposed_code_changes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  // What triggered the change
  findingTitle: text("finding_title").notNull(),
  findingDescription: text("finding_description").notNull(),
  findingSeverity: varchar("finding_severity").notNull(),
  findingSource: varchar("finding_source").notNull().default('wren_security'),

  // The proposed change
  filePath: text("file_path").notNull(),
  lineStart: integer("line_start").notNull(),
  lineEnd: integer("line_end").notNull(),
  beforeCode: text("before_code").notNull(),
  afterCode: text("after_code").notNull(),
  patchRationale: text("patch_rationale").notNull(),

  // Review
  status: proposedChangeStatusEnum("status").default('pending_review').notNull(),
  reviewerNotes: text("reviewer_notes"),
  aldenDecisionReason: text("alden_decision_reason"),
  reviewedAt: timestamp("reviewed_at"),

  // Application
  appliedAt: timestamp("applied_at"),
  githubSynced: boolean("github_synced").default(false),
  githubCommitHash: varchar("github_commit_hash"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProposedCodeChangeSchema = createInsertSchema(proposedCodeChanges).omit({
  id: true,
  status: true,
  reviewerNotes: true,
  aldenDecisionReason: true,
  reviewedAt: true,
  appliedAt: true,
  githubSynced: true,
  githubCommitHash: true,
  createdAt: true,
});
export type InsertProposedCodeChange = z.infer<typeof insertProposedCodeChangeSchema>;
export type ProposedCodeChange = typeof proposedCodeChanges.$inferSelect;

// ── Agent Activity Log ─────────────────────────────────────────────────────────
// Surfaced in Team Room / Talk to Alden so David can see what agents are doing

export const agentActivityLogs = pgTable("agent_activity_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  actor: varchar("actor").notNull(),
  actionType: varchar("action_type").notNull(),
  title: varchar("title").notNull(),
  details: text("details"),
  status: varchar("status").notNull().default("complete"),
  todos: text("todos").array().default(sql`'{}'`),
  sessionRef: varchar("session_ref"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAgentActivityLogSchema = createInsertSchema(agentActivityLogs).omit({
  id: true,
  createdAt: true,
});
export type InsertAgentActivityLog = z.infer<typeof insertAgentActivityLogSchema>;
export type AgentActivityLog = typeof agentActivityLogs.$inferSelect;

// ── Prop Room: Visual Scene Library ──────────────────────────────────────────
// Base environments (scenes) and their pedagogical zones for Daniela's
// visual vocabulary teaching. See server/services/prop-room-compositor.ts.

export const visualEnvironments = pgTable("visual_environments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  imageUrl: text("image_url").notNull().default(''),
  width: integer("width").notNull().default(1920),
  height: integer("height").notNull().default(1080),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type VisualEnvironment = typeof visualEnvironments.$inferSelect;

export const visualZones = pgTable("visual_zones", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  environmentId: varchar("environment_id").notNull(),
  zoneKey: text("zone_key").notNull(),
  zoneName: text("zone_name").notNull(),
  zoneType: text("zone_type").notNull(), // 'spatial' | 'interactional' | 'departmental' | 'navigational'
  description: text("description").notNull(),
  languageFunctions: text("language_functions").array().notNull().default(sql`'{}'`),
  positionHint: text("position_hint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueEnvZone: uniqueIndex("unique_env_zone").on(table.environmentId, table.zoneKey),
}));
export type VisualZone = typeof visualZones.$inferSelect;

export const visualAssets = pgTable("visual_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  objectType: text("object_type").notNull(),
  imageUrl: text("image_url").notNull().default(''),
  zoneImageUrl: text("zone_image_url"),
  width: integer("width").notNull().default(200),
  height: integer("height").notNull().default(200),
  spanishTerms: text("spanish_terms").array().notNull().default(sql`'{}'`),
  frenchTerms: text("french_terms").array().notNull().default(sql`'{}'`),
  germanTerms: text("german_terms").array().notNull().default(sql`'{}'`),
  italianTerms: text("italian_terms").array().notNull().default(sql`'{}'`),
  portugueseTerms: text("portuguese_terms").array().notNull().default(sql`'{}'`),
  japaneseTerms: text("japanese_terms").array().notNull().default(sql`'{}'`),
  koreanTerms: text("korean_terms").array().notNull().default(sql`'{}'`),
  mandarinTerms: text("mandarin_terms").array().notNull().default(sql`'{}'`),
  arabicTerms: text("arabic_terms").array().notNull().default(sql`'{}'`),
  russianTerms: text("russian_terms").array().notNull().default(sql`'{}'`),
  englishTerms: text("english_terms").array().notNull().default(sql`'{}'`),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type VisualAsset = typeof visualAssets.$inferSelect;

export const visualCompositions = pgTable("visual_compositions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  environmentId: varchar("environment_id").notNull(),
  compositionData: jsonb("composition_data"),
  composedImageUrl: text("composed_image_url"),
  teachingContext: text("teaching_context"),
  vocabTerms: text("vocab_terms").array().notNull().default(sql`'{}'`),
  useCount: integer("use_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type VisualComposition = typeof visualCompositions.$inferSelect;

// === Conversation-Generated Review Items ===
// Items extracted by AI from voice sessions — student-specific review queue
export const userReviewItems = pgTable("user_review_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  language: varchar("language").notNull(), // Target language being learned (e.g. "spanish")
  // What to show the student
  prompt: text("prompt").notNull(),       // English label: "to ask for the bill" / "42"
  targetText: text("target_text").notNull(), // Correct form in target language: "la cuenta, por favor"
  nativeTranslation: text("native_translation"), // Native-language gloss (set for non-English learners)
  context: text("context"),              // Sentence it appeared in during the conversation
  itemType: varchar("item_type").notNull().default("vocabulary"), // vocabulary | phrase | grammar | pronunciation
  // Source tracking
  sourceConversationId: varchar("source_conversation_id").references(() => conversations.id, { onDelete: 'set null' }),
  scenarioSlug: varchar("scenario_slug"), // Which scenario generated this item
  // SRS progress (SM-2 algorithm)
  mastered: boolean("mastered").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  correctCount: integer("correct_count").notNull().default(0),
  lastScore: real("last_score"),
  easeFactor: real("ease_factor").notNull().default(2.5),
  intervalDays: real("interval_days").notNull().default(1),
  nextReviewAt: timestamp("next_review_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_review_items_user_lang").on(table.userId, table.language),
  index("idx_review_items_next_review").on(table.nextReviewAt),
]);

export const insertUserReviewItemSchema = createInsertSchema(userReviewItems).omit({ id: true, createdAt: true });
export type InsertUserReviewItem = z.infer<typeof insertUserReviewItemSchema>;
export type UserReviewItem = typeof userReviewItems.$inferSelect;

export const voiceGracePeriods = pgTable('voice_grace_periods', {
  conversationId: varchar('conversation_id').primaryKey(),
  usageSessionId: varchar('usage_session_id').notNull(),
  compassSessionActive: boolean('compass_session_active').notNull().default(false),
  exchangeCount: integer('exchange_count').notNull().default(0),
  studentSpeakingSeconds: real('student_speaking_seconds').notNull().default(0),
  tutorSpeakingSeconds: real('tutor_speaking_seconds').notNull().default(0),
  ttsCharacters: integer('tts_characters').notNull().default(0),
  sttSeconds: real('stt_seconds').notNull().default(0),
  sessionStartTime: bigint('session_start_time', { mode: 'number' }).notNull(),
  userId: varchar('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** JSON-serialised { notes: string[]; notesSaved: boolean; userId: string } for Reading Room
   *  carry-forward. Null for non-Reading-Room sessions or incognito sessions.
   *  Persisted so carry state survives a server restart during the grace window. */
  rrCarryNotes: text('rr_carry_notes'),
  /** Daniela's in-session scratchpad notes — JSON-serialised string[] so they survive a server
   *  restart during the grace window. Distinct from rrCarryNotes: applies to ALL session types. */
  sessionNotes: text('session_notes'),
});

export const aiCostLogs = pgTable('ai_cost_logs', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  loggedAt: bigint('logged_at', { mode: 'number' }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  context: varchar('context', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
});

// ===== Compartment Installation Tracking =====
// Implements the Madrigal method: one grammatical pattern across many verbs.
// A compartment is a specific pattern slot (e.g. "yo-AR-present") that a student
// either has installed (stable, generative) or doesn't yet (unstarted, pounding, wobbling).
// This is the external session state that should live outside Daniela's context window.

// Status of a single grammatical pattern for a single student
export const compartmentStatusEnum = pgEnum('compartment_status', [
  'unstarted',   // Pattern not yet introduced
  'pounding',    // Pattern being drilled — not yet stable
  'wobbling',    // Was partially stable; wobble detected — return to pounding
  'stable',      // Ending holds under verb rotation — ready to unlock the next person
  'generative',  // Student produced correct form for an unseen verb — compartment is operational
]);

// Type of signal Daniela detected during a conversation
export const compartmentEventTypeEnum = pgEnum('compartment_event_type', [
  'pounding',    // Correct response during active drilling (drill repetition)
  'wobble',      // Ending dropped when verb changed — pattern not yet solid
  'stability',   // Ending held correctly when a new/unseen verb was introduced
  'derivation',  // Student produced the correct form for a verb never drilled — generative proof
  'unlock',      // Daniela introduced the next grammatical person using this compartment as the key
  'review',      // Compartment reviewed after a gap in practice
]);

// One row per student × language × pattern — the current installation state
export const compartmentInstallation = pgTable('compartment_installation', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  language: varchar('language', { length: 30 }).notNull(),   // "spanish", "french", etc.
  patternKey: varchar('pattern_key', { length: 100 }).notNull(), // "yo-AR-present", "tú-ER-present"
  // Current status
  status: compartmentStatusEnum('status').notNull().default('unstarted'),
  // Event counters
  poundingCount: integer('pounding_count').notNull().default(0),
  wobbleCount: integer('wobble_count').notNull().default(0),
  derivationCount: integer('derivation_count').notNull().default(0),
  // Key timestamps
  lastWobbledAt: timestamp('last_wobbled_at'),
  stabilizedAt: timestamp('stabilized_at'),   // When first reached 'stable'
  generativeAt: timestamp('generative_at'),   // When first reached 'generative'
  lastDrilledAt: timestamp('last_drilled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_compartment_user_lang_pattern').on(table.userId, table.language, table.patternKey),
  index('idx_compartment_user_lang').on(table.userId, table.language),
  index('idx_compartment_status').on(table.status),
]);

export const insertCompartmentInstallationSchema = createInsertSchema(compartmentInstallation).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompartmentInstallation = z.infer<typeof insertCompartmentInstallationSchema>;
export type CompartmentInstallation = typeof compartmentInstallation.$inferSelect;

// Append-only event log — Daniela writes one event per signal detected
// This is the session log for pattern-level tracking; never deleted or mutated
export const compartmentEvents = pgTable('compartment_events', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  language: varchar('language', { length: 30 }).notNull(),
  patternKey: varchar('pattern_key', { length: 100 }).notNull(),
  eventType: compartmentEventTypeEnum('event_type').notNull(),
  // Context that produced this signal
  verbContext: varchar('verb_context', { length: 100 }), // which verb was in play (e.g. "bailar")
  studentUtterance: text('student_utterance'),           // what the student actually said
  sessionId: varchar('session_id'),                      // conversation ID
  // Optional Daniela note
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_compartment_events_user_lang').on(table.userId, table.language),
  index('idx_compartment_events_pattern').on(table.userId, table.language, table.patternKey),
  index('idx_compartment_events_session').on(table.sessionId),
  index('idx_compartment_events_type').on(table.eventType),
]);

export const insertCompartmentEventSchema = createInsertSchema(compartmentEvents).omit({ id: true, createdAt: true });
export type InsertCompartmentEvent = z.infer<typeof insertCompartmentEventSchema>;
export type CompartmentEvent = typeof compartmentEvents.$inferSelect;

// ===== Alden Escalation Queue =====
// Persistent DB record of issues Alden detected but cannot auto-repair.
// Survives server restarts — unlike the file-based log this was replacing.
// Written by: alden-escalation-log.ts (watch worker and auto-repair service).
// Read by: the Replit Agent at session start via Alden tools.

export const aldenEscalations = pgTable("alden_escalations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  issueDescription: text("issue_description").notNull(),
  analysis: text("analysis").notNull(),
  trigger: varchar("trigger").notNull().default('recurring_pattern'), // 'recurring_pattern' | 'alert_ineligible'
  status: varchar("status").notNull().default('open'), // 'open' | 'resolved'
  resolvedAt: timestamp("resolved_at"),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAldenEscalationSchema = createInsertSchema(aldenEscalations).omit({ id: true, createdAt: true });
export type InsertAldenEscalation = z.infer<typeof insertAldenEscalationSchema>;
export type AldenEscalation = typeof aldenEscalations.$inferSelect;

// ===== Per-Student Session Health =====
// Lightweight record written at the end of every voice session.
// Captures quality signals so Alden and Lyra can detect individual students
// having degraded experiences — not just system-wide averages.

export const studentSessionHealth = pgTable("student_session_health", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  sessionId: varchar("session_id"), // voice_sessions.id
  language: varchar("language"),
  durationSeconds: integer("duration_seconds").default(0),
  exchangeCount: integer("exchange_count").default(0),
  studentSpeakingSeconds: integer("student_speaking_seconds").default(0),
  errorCount: integer("error_count").default(0),
  qualityScore: real("quality_score"), // 0.0–1.0 computed at session end
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_student_session_health_user").on(table.userId),
  index("idx_student_session_health_created").on(table.createdAt),
]);

export const insertStudentSessionHealthSchema = createInsertSchema(studentSessionHealth).omit({ id: true, createdAt: true });
export type InsertStudentSessionHealth = z.infer<typeof insertStudentSessionHealthSchema>;
export type StudentSessionHealth = typeof studentSessionHealth.$inferSelect;

// ===== Daniela Outbound Queue =====
// Messages Daniela writes during a live session, delivered at the student's next session start
// instead of a generated greeting. Authorship rule: only Daniela writes here, from an active
// session context. No background process may write to this table.

export const danielaOutboundQueue = pgTable("daniela_outbound_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  sessionId: varchar("session_id"), // voice session where the message was written
  content: text("content").notNull(),
  deliveredAt: timestamp("delivered_at"), // null = pending session-start delivery
  smsDeliveredAt: timestamp("sms_delivered_at"), // set once Twilio SMS is sent
  audioUrl: varchar("audio_url"), // app-relative path to the rendered WAV
  audioPlayedAt: timestamp("audio_played_at"), // set on first playback page load
  // Phase 4: VoIP call tracking
  callSid: varchar("call_sid"),                    // Twilio Call SID once initiated
  callAt: timestamp("call_at"),                    // when outbound call was placed
  callAnsweredAt: timestamp("call_answered_at"),   // when student picked up
  callDurationSeconds: integer("call_duration_seconds"), // total call length
  callNoAnswer: boolean("call_no_answer").default(false), // true → fell back to SMS
  callTranscript: text("call_transcript"), // transcription of the recorded phone call
  deliveryError: text("delivery_error"), // set when SMS delivery fails; cleared on retry success
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_daniela_outbound_queue_user").on(table.userId),
  index("idx_daniela_outbound_queue_delivered").on(table.deliveredAt),
]);

export const insertDanielaOutboundQueueSchema = createInsertSchema(danielaOutboundQueue).omit({ id: true, createdAt: true });
export type InsertDanielaOutboundQueue = z.infer<typeof insertDanielaOutboundQueueSchema>;
export type DanielaOutboundQueueItem = typeof danielaOutboundQueue.$inferSelect;

// ===== Daniela Absence Nudges =====
// Tracks which students Daniela has been notified about for absence so she
// is not re-nudged until she resolves the prior nudge (writes a message or
// explicitly dismisses). Authorship rule: only the absence worker writes here.
export const danielaAbsenceNudges = pgTable("daniela_absence_nudges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  notifiedAt: timestamp("notified_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),         // null = Daniela hasn't acted yet
  // Allowed values: 'message_queued' | 'dismissed' | 'student_returned'
  // Enforced at DB level by chk_daniela_absence_nudges_resolution_type below.
  // Typed as NonNullable<ResolutionType> so Drizzle insert/update calls reject
  // unknown strings at compile time — the column is still nullable at runtime
  // (null means Daniela hasn't acted yet).
  resolutionType: varchar("resolution_type").$type<NonNullable<ResolutionType>>(),
  suppressUntil: timestamp("suppress_until"),   // if Daniela snoozes, no re-nudge before this
  lastSessionDate: timestamp("last_session_date"),
  daysSinceLastSession: integer("days_since_last_session"),
}, (table) => [
  index("idx_daniela_absence_nudges_user").on(table.userId),
  index("idx_daniela_absence_nudges_resolved").on(table.resolvedAt),
  check(
    "chk_daniela_absence_nudges_resolution_type",
    sql`${table.resolutionType} IS NULL OR ${table.resolutionType} IN ('message_queued', 'dismissed', 'student_returned')`,
  ),
]);

export const insertDanielaAbsenceNudgeSchema = createInsertSchema(danielaAbsenceNudges)
  .omit({ id: true, notifiedAt: true })
  .extend({
    // Refine resolutionType so runtime validation matches the compile-time type.
    // Values are sourced from RESOLUTION_TYPE_VALUES so schema.ts and
    // absence-types.ts can never drift apart.
    resolutionType: z.enum(RESOLUTION_TYPE_VALUES).nullable().optional(),
  });
export type InsertDanielaAbsenceNudge = z.infer<typeof insertDanielaAbsenceNudgeSchema>;
export type DanielaAbsenceNudge = typeof danielaAbsenceNudges.$inferSelect;

// ===== Student Absence Config =====
// Per-student absence threshold override. When set, the absence worker uses
// this threshold instead of the global ABSENCE_THRESHOLD_DAYS constant.
// Primary use case: weekly learners or travellers who need a longer window
// before Daniela is notified. One row per student (upserted by userId).
export const studentAbsenceConfig = pgTable("student_absence_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  thresholdDays: integer("threshold_days").notNull(),  // custom absence threshold in days
  notes: text("notes"),  // optional explanation (e.g. "weekly learner — travels for work")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_student_absence_config_user").on(table.userId),
]);

export const insertStudentAbsenceConfigSchema = createInsertSchema(studentAbsenceConfig).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertStudentAbsenceConfig = z.infer<typeof insertStudentAbsenceConfigSchema>;
export type StudentAbsenceConfig = typeof studentAbsenceConfig.$inferSelect;

// ===== Student Contact Preferences =====
// Stores phone number and explicit SMS/voice consent for outbound Daniela contact.
// Written only on explicit student action (settings UI or in-session verbal consent).
// Phone stored in E.164 format. Consent timestamps track when each type was granted.
// One row per student (upsert on userId).
export const studentContactPreferences = pgTable("student_contact_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  phone: varchar("phone"),                                          // E.164 e.g. +15551234567
  phoneConsentSms: boolean("phone_consent_sms").notNull().default(false),   // opt-in for SMS
  phoneConsentVoice: boolean("phone_consent_voice").notNull().default(false), // opt-in for voice calls
  phoneConsentAt: timestamp("phone_consent_at"),                    // when consent was last updated
  phoneConsentSource: varchar("phone_consent_source"),              // 'manual_entry' | 'in_session'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_student_contact_pref_user").on(table.userId),
]);

export const insertStudentContactPreferencesSchema = createInsertSchema(studentContactPreferences).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertStudentContactPreferences = z.infer<typeof insertStudentContactPreferencesSchema>;
export type StudentContactPreferences = typeof studentContactPreferences.$inferSelect;

// Zod schema for the PUT /api/user/contact-preferences endpoint
export const updateContactPreferencesSchema = z.object({
  phone: z.string()
    .regex(/^\+[1-9]\d{7,14}$/, "Phone must be in E.164 format (e.g. +15551234567)")
    .nullable()
    .optional(),
  phoneConsentSms: z.boolean().optional(),
  phoneConsentVoice: z.boolean().optional(),
});

// ─── Learning Goals ──────────────────────────────────────────────────────────

/**
 * A single learnable capability within a student's goal.
 * Tracked through four stages Daniela advances silently based on observation:
 *   planned   → introduced but not yet touched in session
 *   planted   → Daniela introduced it; student recognises it with support
 *   practiced → student can reproduce it when prompted (controlled production)
 *   integrated → student uses it spontaneously to solve a real comm. problem
 */
export interface GoalCapability {
  id: string;              // slug e.g. "restaurant_ordering"
  name: string;            // "Order food at a restaurant without freezing"
  status: 'planned' | 'planted' | 'practiced' | 'integrated';
  notes: string[];         // Daniela's evidence notes for each advance
  addedAt: string;         // ISO timestamp when added to goal
  lastAdvancedAt?: string; // ISO timestamp of last status change
}

/**
 * A student's active learning goal — outcome-based ("order food, get directions")
 * rather than level-based ("reach B2"). Designed for self-directed students and
 * business travelers who aren't following the textbook curriculum.
 *
 * Only one goal per student+language is active at a time. When a goal evolves
 * (trip → ongoing interest), the old goal is deactivated and a new one created,
 * carrying forward any Integrated capabilities.
 */
export const learningGoals = pgTable("learning_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull().references(() => users.id),
  language: varchar("language").notNull(),
  goalStatement: text("goal_statement").notNull(),   // What the student said they want to be able to do
  targetDate: timestamp("target_date"),              // Optional deadline (trip date, meeting date)
  capabilities: jsonb("capabilities").$type<GoalCapability[]>().default([]),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_learning_goals_student").on(table.studentId),
  index("idx_learning_goals_student_lang").on(table.studentId, table.language),
  index("idx_learning_goals_active").on(table.studentId, table.isActive),
]);

export const insertLearningGoalSchema = createInsertSchema(learningGoals).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLearningGoal = z.infer<typeof insertLearningGoalSchema>;
export type LearningGoal = typeof learningGoals.$inferSelect;

/**
 * Teaching Skills — named, executable pedagogical routines Daniela can invoke by name.
 * Each skill is a compound sequence of her existing tools, pre-reasoned and pre-scripted.
 * When she calls invoke_teaching_skill("madrigal_chapter_drill", {...}), she gets back an
 * exact step-by-step script with tool call instructions she follows herself.
 *
 * Madrigal-aligned skills encode the proper Madrigal method precisely so Daniela doesn't
 * have to re-derive the pedagogy from context on every turn.
 */
export const teachingSkills = pgTable("teaching_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  name: varchar("name").notNull().unique(),
  title: varchar("title").notNull(),
  description: text("description"),
  triggerConditions: text("trigger_conditions"),

  steps: jsonb("steps").notNull(),
  paramsSchema: jsonb("params_schema"),

  madrigalAligned: boolean("madrigal_aligned").default(false),
  chapterTypes: varchar("chapter_types").array(),
  actflLevels: varchar("actfl_levels").array(),

  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  originProposalId: varchar("origin_proposal_id"),
});

export const insertTeachingSkillSchema = createInsertSchema(teachingSkills).omit({ id: true, createdAt: true });
export type InsertTeachingSkill = z.infer<typeof insertTeachingSkillSchema>;
export type TeachingSkill = typeof teachingSkills.$inferSelect;

/**
 * Persistent cache mapping image URLs → Gemini-visible descriptions.
 * First time an image URL is shown to Daniela, we fetch the bytes and send as inlineData.
 * After that, we store a text description here so future sessions can use text instead
 * of re-fetching bytes — saving latency and keeping the context window clean.
 */
export const imageVisionCache = pgTable("image_vision_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  imageUrl: text("image_url").notNull(),
  description: text("description"),
  mimeType: varchar("mime_type", { length: 50 }).notNull().default("image/jpeg"),
  sourceConversationId: varchar("source_conversation_id"), // conversation where this image was first shown
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_image_vision_cache_url").on(table.imageUrl),
]);

// ===== Build Queue (tiered autonomy — Alden/Agent proposals for async review) =====

export const buildQueueStatusEnum = pgEnum('build_queue_status', [
  'pending',    // awaiting review
  'approved',   // approved, waiting to execute
  'executing',  // currently being applied
  'done',       // successfully executed
  'rejected',   // rejected, will not execute
]);

export const buildQueueProposerEnum = pgEnum('build_queue_proposer', ['alden', 'agent']);

export const buildQueue = pgTable("build_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  proposedBy: buildQueueProposerEnum("proposed_by").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  filesAffected: text("files_affected").array(),
  isSafeZone: boolean("is_safe_zone").notNull().default(false),
  diff: text("diff"),
  status: buildQueueStatusEnum("status").notNull().default('pending'),
  priority: integer("priority").notNull().default(5),
  reviewedBy: text("reviewed_by"),
  reviewNote: text("review_note"),
  proposedAt: timestamp("proposed_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  executedAt: timestamp("executed_at"),
  result: text("result"),
});

export const insertBuildQueueSchema = createInsertSchema(buildQueue).omit({
  id: true, proposedAt: true, reviewedAt: true, executedAt: true,
});
export type InsertBuildQueue = z.infer<typeof insertBuildQueueSchema>;
export type BuildQueueItem = typeof buildQueue.$inferSelect;

// ===== Alden Watch Config (self-tuning parameters) =====

export const aldenWatchConfig = pgTable("alden_watch_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  checkIntervalHours: integer("check_interval_hours").notNull().default(2),
  recoveryPollMinutes: integer("recovery_poll_minutes").notNull().default(10),
  budgetWarnUsd: integer("budget_warn_usd").notNull().default(3),
  budgetAlertUsd: integer("budget_alert_usd").notNull().default(5),
  lowHealthThreshold: integer("low_health_threshold").notNull().default(70),
  consecutiveLowScoreTrigger: integer("consecutive_low_score_trigger").notNull().default(3),
  fingerprintTtlHours: integer("fingerprint_ttl_hours").notNull().default(24),
  updatedBy: text("updated_by").notNull().default('system'),
  updateReason: text("update_reason"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AldenWatchConfig = typeof aldenWatchConfig.$inferSelect;

// ===== Alden Engine Config (Anthropic default / Gemini "inside man" mode) =====

export const aldenConfig = pgTable("alden_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  engine: text("engine").notNull().default('anthropic'), // 'anthropic' | 'gemini'
  updatedBy: text("updated_by").notNull().default('system'),
  reason: text("reason"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AldenConfig = typeof aldenConfig.$inferSelect;

export const aldenEngineSwitches = pgTable("alden_engine_switches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromEngine: text("from_engine").notNull(),
  toEngine: text("to_engine").notNull(),
  initiatedBy: text("initiated_by").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_alden_engine_switches_created").on(table.createdAt),
]);

export type AldenEngineSwitch = typeof aldenEngineSwitches.$inferSelect;

// ===== Pedagogical Loop State Machine =====
// Server-side tracking of structured teaching sequences. Persists across GL
// context window decay — Daniela queries this via get_current_teaching_context,
// start_madrigal_loop, advance_loop_step, and suspend_current_loop tools.

export const pedagogicalLoopStatusEnum = pgEnum('pedagogical_loop_status', [
  'active',     // currently in progress
  'suspended',  // paused by student/tangent; resumable when context returns
  'completed',  // all steps finished; lesson recorded via mark_lesson_covered
  'abandoned',  // session ended without completion; Shadow Auditor reconciles
]);

export const pedagogicalLoopTypeEnum = pgEnum('pedagogical_loop_type', [
  'madrigal_4step',    // Madrigal visual sequence: anchor → images → combinator → drill
  'grammar_drill',     // Grammar pattern drill loop
  'actfl_checkpoint',  // ACTFL proficiency checkpoint sequence
]);

export const pedagogicalLoopState = pgTable("pedagogical_loop_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => tutorSessions.id),
  studentId: varchar("student_id").notNull(),
  status: pedagogicalLoopStatusEnum("status").notNull().default('active'),
  loopType: pedagogicalLoopTypeEnum("loop_type").notNull(),
  loopContentKey: varchar("loop_content_key", { length: 200 }).notNull(),
  currentStep: integer("current_step").notNull().default(0),
  totalSteps: integer("total_steps").notNull(),
  stepData: jsonb("step_data").notNull(),
  studentPerformance: jsonb("student_performance").notNull().default([]),
  suspendReason: text("suspend_reason"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  suspendedAt: timestamp("suspended_at"),
}, (table) => [
  index("idx_pedagogical_loop_session").on(table.sessionId),
  index("idx_pedagogical_loop_student_status").on(table.studentId, table.status),
]);

export const insertPedagogicalLoopStateSchema = createInsertSchema(pedagogicalLoopState).omit({
  id: true, startedAt: true, completedAt: true, suspendedAt: true,
});
export type InsertPedagogicalLoopState = z.infer<typeof insertPedagogicalLoopStateSchema>;
export type PedagogicalLoopState = typeof pedagogicalLoopState.$inferSelect;

// ── Pedagogical Brief (Intention MVP) ────────────────────────────────────────
// Daniela's working theory for a student, written at session end.
// Append-only: never overwrite — track how the intention evolves over time.
// Read at session start: latest brief injected into pre-session synthesis.
export const studentPedagogicalBriefs = pgTable("student_pedagogical_briefs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  sessionId: varchar("session_id"), // source session that generated this brief
  brief: text("brief").notNull(), // 3-sentence pedagogical brief
  focusArea: text("focus_area"), // what to prioritize next session
  struggledWith: text("struggled_with"), // what the student found hard this session
  notedProgress: text("noted_progress"), // what went well / what advanced
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_ped_brief_user_lang").on(table.userId, table.language),
]);

export const insertStudentPedagogicalBriefSchema = createInsertSchema(studentPedagogicalBriefs).omit({
  id: true, createdAt: true,
});
export type InsertStudentPedagogicalBrief = z.infer<typeof insertStudentPedagogicalBriefSchema>;
export type StudentPedagogicalBrief = typeof studentPedagogicalBriefs.$inferSelect;

// ── ACTFL Mastery Evidence ────────────────────────────────────────────────────
// Time-series evidence for Can-Do statement mastery.
// Separate from studentCanDoProgress (which is boolean flags).
// Each row = one observed performance in a session.
// Confidence scores decay over time — the aggregate view drives the mastery digest.

// Bridge: curriculum unit → Can-Do statements it addresses
export const curriculumUnitCanDoMap = pgTable("curriculum_unit_can_do_map", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  unitId: varchar("unit_id").notNull().references(() => curriculumUnits.id),
  canDoStatementId: varchar("can_do_statement_id").notNull().references(() => canDoStatements.id),
  isPrimary: boolean("is_primary").default(true), // primary vs supporting coverage
}, (table) => [
  index("idx_unit_can_do_unit").on(table.unitId),
  index("idx_unit_can_do_statement").on(table.canDoStatementId),
]);

// Time-series evidence rows — one per observation per session
export const studentCanDoEvidence = pgTable("student_can_do_evidence", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  canDoStatementId: varchar("can_do_statement_id").notNull().references(() => canDoStatements.id),
  language: text("language").notNull(),
  sessionId: varchar("session_id"), // session where this was observed
  confidenceScore: integer("confidence_score").notNull(), // 0-100
  transcriptExcerpt: text("transcript_excerpt"), // the moment it happened (for explainability)
  workerNotes: text("worker_notes"), // why the AI scored this way
  observedAt: timestamp("observed_at").notNull().defaultNow(),
}, (table) => [
  index("idx_can_do_evidence_user_lang").on(table.userId, table.language),
  index("idx_can_do_evidence_statement").on(table.canDoStatementId),
]);

export const insertStudentCanDoEvidenceSchema = createInsertSchema(studentCanDoEvidence).omit({
  id: true, observedAt: true,
});
export type InsertStudentCanDoEvidence = z.infer<typeof insertStudentCanDoEvidenceSchema>;
export type StudentCanDoEvidence = typeof studentCanDoEvidence.$inferSelect;

// ===== ACTFL Level Change Audit Log =====
// Append-only record of every time a student's ACTFL level changes, with a
// pointer back to the conversation that provided the evidence.  Enables
// review, dispute, and re-testing without losing the triggering context.
export const actflLevelChanges = pgTable("actfl_level_changes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  language: text("language").notNull(),
  fromLevel: text("from_level"),           // null = first ever assessment
  toLevel: text("to_level").notNull(),
  conversationId: text("conversation_id"), // conversation that produced the evidence
  triggeredBy: text("triggered_by").notNull(), // 'placement_tool' | 'placement_chat' | 'manual'
  reason: text("reason"),                  // AI reasoning or human note
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_actfl_level_changes_user_lang").on(table.userId, table.language),
]);

export const insertActflLevelChangesSchema = createInsertSchema(actflLevelChanges).omit({
  id: true,
  createdAt: true,
});
export type InsertActflLevelChange = z.infer<typeof insertActflLevelChangesSchema>;
export type ActflLevelChange = typeof actflLevelChanges.$inferSelect;

// ===== SCENE WORLD LEDGER =====
// Narrative facts about a student's history in a named scene, persisted across sessions.
// NOT coordinate or prop data — only semantic facts Daniela can reference on scene entry.
// Examples: { has_paid_tab: true, relationship_with_barista: "friendly", last_item: "croissant" }
// Daniela writes via update_world_ledger; server injects on OPEN_SCENE.
export const sceneWorldLedger = pgTable('scene_world_ledger', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull().references(() => users.id),
  sceneName: text('scene_name').notNull(),
  ledger: jsonb('ledger').notNull().default('{}'),
  tension: doublePrecision('tension').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_scene_world_ledger_user_scene').on(table.userId, table.sceneName),
]);

export const insertSceneWorldLedgerSchema = createInsertSchema(sceneWorldLedger).omit({ id: true, updatedAt: true });
export type InsertSceneWorldLedger = z.infer<typeof insertSceneWorldLedgerSchema>;
export type SceneWorldLedger = typeof sceneWorldLedger.$inferSelect;

// ===== MASTERY EVIDENCE =====
// Durable record of vocabulary words a student has demonstrably mastered in-scene.
// Written fire-and-forget from tension-evaluator when pragmaticScore >= 4 and
// the active grounded prop carries vocab[].  Unique on (userId, word, language)
// so re-mastering the same word is a no-op (ON CONFLICT DO NOTHING).
// Powers future spaced-repetition queries and Madrigal unit cross-linking.
export const masteryEvidence = pgTable('mastery_evidence', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar('user_id').notNull().references(() => users.id),
  word: text('word').notNull(),
  language: text('language').notNull(),
  sceneName: text('scene_name'),             // scene where mastery was demonstrated
  propName: text('prop_name'),               // which prop carried the vocab
  attemptsCount: integer('attempts_count').notNull().default(1), // upserted on re-mastery
  lastPragmaticScore: integer('last_pragmatic_score'), // score at time of mastery (1-5)
  masteredAt: timestamp('mastered_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_mastery_evidence_user_lang').on(table.userId, table.language),
  uniqueIndex('idx_mastery_evidence_user_word_lang').on(table.userId, table.word, table.language),
]);

export const insertMasteryEvidenceSchema = createInsertSchema(masteryEvidence).omit({ id: true, masteredAt: true });
export type InsertMasteryEvidence = z.infer<typeof insertMasteryEvidenceSchema>;
export type MasteryEvidence = typeof masteryEvidence.$inferSelect;

// ===== OBSERVER SEAT RUNS =====
// Persistent record of every Observer Seat diagnostic run.
// Stores full visual data (scene image URL, vocab image URLs, transcript)
// so Luca can review past sessions and Claude Code can fetch them via API.
// Image URLs come from visual_assets (object storage) — they are stable.
// Audio is uploaded to object storage and stored as a permanent URL.
export const observerSeatRuns = pgTable('observer_seat_runs', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  scenarioLabel: text('scenario_label').notNull().default(''),
  language: text('language').notNull().default('es-ES'),
  promptText: text('prompt_text').notNull().default(''),
  transcript: text('transcript').notNull().default(''),
  toolCallsJson: jsonb('tool_calls_json').notNull().default([]),
  visualEventsJson: jsonb('visual_events_json').notNull().default([]),
  coverageJson: jsonb('coverage_json').notNull().default({}),
  audioDurationS: real('audio_duration_s').notNull().default(0),
  audioUrl: text('audio_url'),
  grade: text('grade').notNull().default('FAIL'),
});

export const insertObserverSeatRunSchema = createInsertSchema(observerSeatRuns).omit({ id: true, runAt: true });
export type InsertObserverSeatRun = z.infer<typeof insertObserverSeatRunSchema>;
export type ObserverSeatRun = typeof observerSeatRuns.$inferSelect;

// ===== STUDENT MILESTONES =====
// Tracks pedagogical gate events per student per language.
// Primary use: Madrigal tú reveal gate (usted_fluency + tu_revealed).
// Threshold for tú unlock: 25 successful communicative uses of usted/third-person
// across at least 2 distinct calendar days (sleep cycle matters).
export const studentMilestones = pgTable("student_milestones", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").notNull(),
  language: varchar("language").notNull().default("spanish"),
  milestoneKey: varchar("milestone_key").notNull(),
  // Examples: 'usted_fluency' (tracking counter), 'tu_revealed' (gate unlocked)
  successCount: integer("success_count").default(0),
  distinctDays: integer("distinct_days").default(0),
  // Tracks the last calendar date a fluency instance was recorded (YYYY-MM-DD).
  // Stored as a plain string to avoid timezone ambiguity across sessions.
  lastEvidenceDateStr: varchar("last_evidence_date_str"),
  unlockedAt: timestamp("unlocked_at"),
  lastEvidenceAt: timestamp("last_evidence_at"),
  evidenceSummary: text("evidence_summary"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_student_milestones_student").on(table.studentId, table.language),
  uniqueIndex("idx_student_milestones_unique").on(table.studentId, table.language, table.milestoneKey),
]);

export const insertStudentMilestoneSchema = createInsertSchema(studentMilestones).omit({ id: true, createdAt: true });
export type InsertStudentMilestone = z.infer<typeof insertStudentMilestoneSchema>;
export type StudentMilestone = typeof studentMilestones.$inferSelect;

// ===== SOPHIA — STUDENT SUPPORT LAYER =====
// Sophia handles the operational/technical layer of a session.
// Daniela notices a technical problem, hands it off via escalate_to_support,
// and Sophia works it while Daniela stays in the lesson.
// Sophia is text-only — the voice channel stays exclusively Daniela's.
// Alden summarizes incident patterns into long-term learner_personal_facts post-session.

export const sophiaIncidentTriggerEnum = pgEnum('sophia_incident_trigger', [
  'daniela_referral',    // Daniela called escalate_to_support
  'telemetry_auto',      // Sophia detected autonomously (e.g. GL socket dropped while Daniela unreachable)
]);

export const sophiaIncidentCategoryEnum = pgEnum('sophia_incident_category', [
  'audio_input',    // mic muted, no audio from student
  'audio_output',   // student can't hear Daniela
  'connection',     // WebSocket drop, reconnect failure
  'tool_render',    // a whiteboard tool didn't render on student's screen
  'ui_sync',        // UI state mismatch
  'other',          // catch-all
]);

export const sophiaIncidentStatusEnum = pgEnum('sophia_incident_status', [
  'detected',        // incident logged, Sophia not yet engaged
  'investigating',   // Sophia actively working
  'instructing',     // Sophia has given the student steps to follow
  'resolved',        // issue resolved, all_clear sent to Daniela
  'unresolved',      // session ended without resolution
  'escalated',       // escalated to human support (future)
]);

export const sophiaIncidents = pgTable("sophia_incidents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull(),   // tutor_sessions.id
  studentId: varchar("student_id").notNull(),
  conversationId: varchar("conversation_id"),   // links to conversation context
  triggerSource: sophiaIncidentTriggerEnum("trigger_source").notNull(),
  category: sophiaIncidentCategoryEnum("category").notNull(),
  status: sophiaIncidentStatusEnum("status").notNull().default('detected'),
  issueDescription: text("issue_description").notNull(),  // Daniela's description or auto-detected text
  priority: varchar("priority").notNull().default('medium'),  // low | medium | high
  resolutionStepsSummary: text("resolution_steps_summary"),   // what Sophia told the student
  allClearSentAt: timestamp("all_clear_sent_at"),             // when all_clear was fired back to Daniela
  resolvedAt: timestamp("resolved_at"),
  sessionEndedUnresolved: boolean("session_ended_unresolved").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sophia_incidents_session").on(table.sessionId),
  index("idx_sophia_incidents_student").on(table.studentId),
  index("idx_sophia_incidents_status").on(table.status),
]);

export const insertSophiaIncidentSchema = createInsertSchema(sophiaIncidents).omit({ id: true, createdAt: true });
export type InsertSophiaIncident = z.infer<typeof insertSophiaIncidentSchema>;
export type SophiaIncident = typeof sophiaIncidents.$inferSelect;

// Sophia's per-incident message log — what she said to the student during this incident
export const sophiaMessages = pgTable("sophia_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  incidentId: varchar("incident_id").notNull().references(() => sophiaIncidents.id),
  role: varchar("role").notNull(),   // 'sophia' | 'student'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_sophia_messages_incident").on(table.incidentId),
]);

export const insertSophiaMessageSchema = createInsertSchema(sophiaMessages).omit({ id: true, createdAt: true });
export type InsertSophiaMessage = z.infer<typeof insertSophiaMessageSchema>;
export type SophiaMessage = typeof sophiaMessages.$inferSelect;

// Founder-attested task ownership.  Challenge/receipt/nonce rows are the only
// mutable state; decision and proof rows are append-only evidence.
export const taskOwnershipChallenges = pgTable("task_ownership_challenges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskRef: varchar("task_ref", { length: 128 }).notNull(),
  artifactSha256: varchar("artifact_sha256", { length: 64 }).notNull(),
  intendedActor: varchar("intended_actor", { length: 128 }).notNull(),
  coordinationActor: varchar("coordination_actor", { length: 128 }).notNull(),
  publicKey: text("public_key").notNull(),
  keyFingerprint: varchar("key_fingerprint", { length: 128 }).notNull(),
  contextDigest: varchar("context_digest", { length: 128 }),
  serverNonce: varchar("server_nonce", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  decidedAt: timestamp("decided_at"),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
}, (t) => [
  uniqueIndex("uq_task_ownership_challenge_nonce").on(t.serverNonce),
  uniqueIndex("uq_task_ownership_challenge_idempotency").on(t.coordinationActor, t.idempotencyKey),
  index("idx_task_ownership_challenge_status").on(t.status, t.expiresAt),
  check("task_ownership_challenge_task_ref", sql`${t.taskRef} ~ '^[1-9][0-9]*$'`),
  check("task_ownership_challenge_artifact_sha256", sql`${t.artifactSha256} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_challenge_fingerprint_sha256", sql`${t.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_challenge_context_digest", sql`${t.contextDigest} IS NULL OR ${t.contextDigest} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_challenge_request_digest", sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_challenge_actor_match", sql`${t.intendedActor} = ${t.coordinationActor}`),
  check("task_ownership_challenge_status", sql`${t.status} IN ('pending','approved','rejected','expired')`),
  check("task_ownership_challenge_lifecycle", sql`${t.expiresAt} > ${t.createdAt} AND ((${t.status} = 'pending' AND ${t.decidedAt} IS NULL) OR (${t.status} <> 'pending' AND ${t.decidedAt} IS NOT NULL))`),
]);

export const taskOwnershipReceipts = pgTable("task_ownership_receipts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  challengeId: varchar("challenge_id").notNull().references(() => taskOwnershipChallenges.id),
  taskRef: varchar("task_ref", { length: 128 }).notNull(),
  artifactSha256: varchar("artifact_sha256", { length: 64 }).notNull(),
  intendedActor: varchar("intended_actor", { length: 128 }).notNull(),
  publicKey: text("public_key").notNull(),
  keyFingerprint: varchar("key_fingerprint", { length: 128 }).notNull(),
  contextDigest: varchar("context_digest", { length: 128 }),
  approvedBy: varchar("approved_by").notNull(),
  approvedAt: timestamp("approved_at").notNull().defaultNow(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  version: integer("version").notNull().default(1),
  payloadDigest: varchar("payload_digest", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  revokedAt: timestamp("revoked_at"),
}, (t) => [
  uniqueIndex("uq_task_ownership_receipt_challenge").on(t.challengeId),
  uniqueIndex("uq_task_ownership_active_task").on(t.taskRef).where(sql`${t.status} = 'active'`),
  index("idx_task_ownership_receipt_task").on(t.taskRef, t.status),
  check("task_ownership_receipt_task_ref", sql`${t.taskRef} ~ '^[1-9][0-9]*$'`),
  check("task_ownership_receipt_artifact_sha256", sql`${t.artifactSha256} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_receipt_fingerprint_sha256", sql`${t.keyFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_receipt_context_digest", sql`${t.contextDigest} IS NULL OR ${t.contextDigest} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_receipt_payload_digest", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
  check("task_ownership_receipt_version", sql`${t.version} = 1`),
  check("task_ownership_receipt_status", sql`${t.status} IN ('active','revoked','expired')`),
  check("task_ownership_receipt_lifecycle", sql`${t.expiresAt} > ${t.issuedAt} AND ((${t.status} = 'active' AND ${t.revokedAt} IS NULL) OR (${t.status} <> 'active' AND ${t.revokedAt} IS NOT NULL))`),
]);

export const taskOwnershipProofNonces = pgTable("task_ownership_proof_nonces", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  receiptId: varchar("receipt_id").notNull().references(() => taskOwnershipReceipts.id),
  nonce: varchar("nonce", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_task_ownership_proof_nonce").on(t.nonce),
  check("task_ownership_proof_nonce_lifecycle", sql`${t.expiresAt} > ${t.createdAt} AND (${t.consumedAt} IS NULL OR ${t.consumedAt} >= ${t.createdAt})`),
]);

export const taskOwnershipDecisionEvents = pgTable("task_ownership_decision_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  challengeId: varchar("challenge_id").notNull().references(() => taskOwnershipChallenges.id),
  receiptId: varchar("receipt_id").references(() => taskOwnershipReceipts.id),
  decision: varchar("decision", { length: 16 }).notNull(),
  actorId: varchar("actor_id").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  check("task_ownership_decision_event_decision", sql`${t.decision} IN ('approved','rejected','revoked','expired')`),
  check("task_ownership_decision_event_actor", sql`length(trim(${t.actorId})) > 0`),
]);

export const taskOwnershipProofAttempts = pgTable("task_ownership_proof_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nonceId: varchar("nonce_id").notNull().references(() => taskOwnershipProofNonces.id),
  receiptId: varchar("receipt_id").notNull().references(() => taskOwnershipReceipts.id),
  success: boolean("success").notNull(),
  errorCode: varchar("error_code", { length: 64 }),
  payloadDigest: varchar("payload_digest", { length: 128 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  check("task_ownership_proof_attempt_outcome", sql`(${t.success} AND ${t.errorCode} IS NULL) OR (NOT ${t.success} AND ${t.errorCode} IS NOT NULL)`),
  check("task_ownership_proof_attempt_digest", sql`${t.payloadDigest} IS NULL OR ${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
]);

// Gate 3 is a durable capability: it is only valid while every authority row
// it names remains valid.  All values are copied from locked source rows at
// issuance time so validation never trusts request-supplied task metadata.
export const coordinationGate3ProofGrants = pgTable("coordination_gate3_proof_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  receiptId: varchar("receipt_id").notNull().references(() => taskOwnershipReceipts.id, { onDelete: "restrict" }),
  credentialId: varchar("credential_id").notNull().references(() => coordinationRuntimeCredentials.id, { onDelete: "restrict" }),
  runtimeRegistrationId: varchar("runtime_registration_id", { length: 120 }).notNull()
    .references(() => coordinationRuntimeRegistrations.id, { onDelete: "restrict" }),
  profileId: varchar("profile_id").notNull().references(() => coordinationRuntimeProfiles.id, { onDelete: "restrict" }),
  actor: varchar("actor", { length: 80 }).notNull(),
  taskRef: varchar("task_ref", { length: 128 }).notNull(),
  artifactSha256: varchar("artifact_sha256", { length: 64 }).notNull(),
  contextDigest: varchar("context_digest", { length: 64 }).notNull(),
  startingCommit: varchar("starting_commit", { length: 64 }).notNull(),
  proofPayloadDigest: varchar("proof_payload_digest", { length: 64 }).notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_coordination_gate3_grant_bindings")
    .on(t.receiptId, t.credentialId, t.runtimeRegistrationId, t.profileId),
  index("idx_coordination_gate3_grants_credential").on(t.credentialId, t.expiresAt),
  index("idx_coordination_gate3_grants_runtime_profile").on(t.runtimeRegistrationId, t.profileId, t.expiresAt),
  check("coordination_gate3_grant_actor", sql`${t.actor} = 'luca-gemini'`),
  check("coordination_gate3_grant_task_ref", sql`${t.taskRef} = '1448'`),
  check("coordination_gate3_grant_artifact_sha256", sql`${t.artifactSha256} ~ '^[0-9a-f]{64}$'`),
  check("coordination_gate3_grant_context_digest", sql`${t.contextDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_gate3_grant_starting_commit", sql`${t.startingCommit} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'`),
  check("coordination_gate3_grant_proof_digest", sql`${t.proofPayloadDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_gate3_grant_lifecycle", sql`${t.expiresAt} > ${t.issuedAt} AND (${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.issuedAt})`),
]);

// Coordinator V2 runtime bootstrap evidence is intentionally independent from
// task/session authority. These records are append-only; migration 0052 adds
// database triggers to reject updates and deletes.
export const coordinationV2RuntimeReleases = pgTable("coordination_v2_runtime_releases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  protocolVersion: integer("protocol_version").notNull(),
  sourcePromotionId: varchar("source_promotion_id").notNull()
    .references(() => coordinationV2SourcePromotions.id, { onDelete: "restrict" }),
  repositoryIdentity: varchar("repository_identity", { length: 512 }).notNull(),
  promotedCommitSha: varchar("promoted_commit_sha", { length: 40 }).notNull(),
  exactTreeSha: varchar("exact_tree_sha", { length: 40 }).notNull(),
  publicationReference: varchar("publication_reference", { length: 512 }).notNull(),
  protectedValidationId: varchar("protected_validation_id", { length: 128 }).notNull(),
  sourcePromotionRecordDigest: varchar("source_promotion_record_digest", { length: 64 }).notNull(),
  releaseDigest: varchar("release_digest", { length: 64 }).notNull(),
  manifestTemplateDigest: varchar("manifest_template_digest", { length: 64 }).notNull(),
  nodeVersion: varchar("node_version", { length: 32 }).notNull(),
  nodeReleaseKeyringCommit: varchar("node_release_keyring_commit", { length: 40 }).notNull(),
  nodeReleaseKeyringDigest: varchar("node_release_keyring_digest", { length: 64 }).notNull(),
  nodeShasumsDigest: varchar("node_shasums_digest", { length: 64 }).notNull(),
  nodeSignatureDigest: varchar("node_signature_digest", { length: 64 }).notNull(),
  nodeSignerFingerprint: varchar("node_signer_fingerprint", { length: 40 }).notNull(),
  lockfileDigest: varchar("lockfile_digest", { length: 64 }).notNull(),
  runtimeClosureDigest: varchar("runtime_closure_digest", { length: 64 }).notNull(),
  provenanceDigest: varchar("provenance_digest", { length: 64 }).notNull(),
  sourceMembers: jsonb("source_members")
    .$type<Array<{ fixedPath: string; sha256: string }>>()
    .notNull(),
  publishedAt: timestamp("published_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_runtime_release_digest").on(table.releaseDigest),
  index("idx_coordination_v2_runtime_release_published").on(table.publishedAt),
  check("coordination_v2_runtime_release_protocol", sql`${table.protocolVersion} = 1`),
  check("coordination_v2_runtime_release_commit", sql`${table.promotedCommitSha} ~ '^[0-9a-f]{40}$'`),
  check("coordination_v2_runtime_release_tree", sql`${table.exactTreeSha} ~ '^[0-9a-f]{40}$'`),
  check("coordination_v2_runtime_release_source_digest", sql`${table.sourcePromotionRecordDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_digest", sql`${table.releaseDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_manifest_template_digest", sql`${table.manifestTemplateDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_node_version", sql`length(trim(${table.nodeVersion})) > 0`),
  check("coordination_v2_runtime_release_node_keyring_commit", sql`${table.nodeReleaseKeyringCommit} ~ '^[0-9a-f]{40}$'`),
  check("coordination_v2_runtime_release_node_keyring_digest", sql`${table.nodeReleaseKeyringDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_node_shasums_digest", sql`${table.nodeShasumsDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_node_signature_digest", sql`${table.nodeSignatureDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_node_signer_fingerprint", sql`${table.nodeSignerFingerprint} ~ '^[0-9A-F]{40}$'`),
  check("coordination_v2_runtime_release_lockfile_digest", sql`${table.lockfileDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_runtime_closure_digest", sql`${table.runtimeClosureDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_provenance_digest", sql`${table.provenanceDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_release_source_members", sql`
    jsonb_typeof(${table.sourceMembers}) = 'array'
    AND jsonb_array_length(
      CASE
        WHEN jsonb_typeof(${table.sourceMembers}) = 'array' THEN ${table.sourceMembers}
        ELSE '[]'::jsonb
      END
    ) > 0
  `),
]);

export const coordinationV2RuntimeReleaseArtifacts = pgTable("coordination_v2_runtime_release_artifacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runtimeReleaseId: varchar("runtime_release_id").notNull()
    .references(() => coordinationV2RuntimeReleases.id, { onDelete: "restrict" }),
  role: varchar("role", { length: 48 }).notNull(),
  fixedDestination: varchar("fixed_destination", { length: 512 }).notNull(),
  objectKey: varchar("object_key", { length: 1024 }).notNull(),
  objectDigest: varchar("object_digest", { length: 64 }).notNull(),
  byteLength: bigint("byte_length", { mode: "number" }).notNull(),
  mediaType: varchar("media_type", { length: 128 }).notNull(),
  requiresAuthenticode: boolean("requires_authenticode").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_runtime_artifact_destination").on(table.runtimeReleaseId, table.fixedDestination),
  check("coordination_v2_runtime_artifact_role", sql`${table.role} IN ('node_executable', 'tsx_runtime_module')`),
  check("coordination_v2_runtime_artifact_digest", sql`${table.objectDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_artifact_length", sql`${table.byteLength} > 0 AND ${table.byteLength} <= 268435456`),
  check("coordination_v2_runtime_artifact_object_key", sql`${table.objectKey} ~ '^coordination-v2/runtime/[0-9a-f]{64}/[A-Za-z0-9._-]+$'`),
]);

export const coordinationV2RuntimeBootstrapIssues = pgTable("coordination_v2_runtime_bootstrap_issues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostEnrollmentId: varchar("host_enrollment_id").notNull()
    .references(() => coordinationV2HostEnrollments.id, { onDelete: "restrict" }),
  runtimeReleaseId: varchar("runtime_release_id").notNull()
    .references(() => coordinationV2RuntimeReleases.id, { onDelete: "restrict" }),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull(),
  manifestDigest: varchar("manifest_digest", { length: 64 }).notNull(),
  issuedAt: timestamp("issued_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_runtime_issue_request").on(table.hostEnrollmentId, table.requestKey),
  uniqueIndex("uq_coordination_v2_runtime_issue_manifest").on(table.manifestDigest),
  unique("uq_coordination_v2_runtime_issue_lineage")
    .on(table.id, table.hostEnrollmentId, table.runtimeReleaseId, table.requestKey, table.manifestDigest),
  check("coordination_v2_runtime_issue_request_digest", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_issue_manifest_digest", sql`${table.manifestDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_issue_expiry", sql`
    ${table.expiresAt} > ${table.issuedAt}
    AND ${table.expiresAt} <= ${table.issuedAt} + interval '5 minutes'
  `),
]);

export const coordinationV2RuntimeBootstrapAcknowledgements = pgTable("coordination_v2_runtime_bootstrap_acknowledgements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostEnrollmentId: varchar("host_enrollment_id").notNull(),
  runtimeReleaseId: varchar("runtime_release_id").notNull(),
  issueId: varchar("issue_id").notNull(),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  manifestDigest: varchar("manifest_digest", { length: 64 }).notNull(),
  localEvidenceDigest: varchar("local_evidence_digest", { length: 64 }).notNull(),
  acknowledgementDigest: varchar("acknowledgement_digest", { length: 64 }).notNull(),
  hostSignatureDigest: varchar("host_signature_digest", { length: 64 }).notNull(),
  acknowledgedAt: timestamp("acknowledged_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_runtime_ack_request").on(table.hostEnrollmentId, table.requestKey),
  uniqueIndex("uq_coordination_v2_runtime_ack_release").on(table.hostEnrollmentId, table.runtimeReleaseId),
  foreignKey({
    name: "fk_coordination_v2_runtime_ack_issue_lineage",
    columns: [table.issueId, table.hostEnrollmentId, table.runtimeReleaseId, table.requestKey, table.manifestDigest],
    foreignColumns: [
      coordinationV2RuntimeBootstrapIssues.id,
      coordinationV2RuntimeBootstrapIssues.hostEnrollmentId,
      coordinationV2RuntimeBootstrapIssues.runtimeReleaseId,
      coordinationV2RuntimeBootstrapIssues.requestKey,
      coordinationV2RuntimeBootstrapIssues.manifestDigest,
    ],
  }).onDelete("restrict"),
  check("coordination_v2_runtime_ack_manifest_digest", sql`${table.manifestDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_ack_evidence_digest", sql`${table.localEvidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_ack_digest", sql`${table.acknowledgementDigest} ~ '^[0-9a-f]{64}$'`),
  check("coordination_v2_runtime_ack_signature_digest", sql`${table.hostSignatureDigest} ~ '^[0-9a-f]{64}$'`),
]);

export const coordinationV2RuntimeReleaseRevocations = pgTable("coordination_v2_runtime_release_revocations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runtimeReleaseId: varchar("runtime_release_id").notNull()
    .references(() => coordinationV2RuntimeReleases.id, { onDelete: "restrict" }),
  requestKey: varchar("request_key", { length: 128 }).notNull(),
  reasonCode: varchar("reason_code", { length: 128 }).notNull(),
  revokedBy: varchar("revoked_by", { length: 128 }).notNull(),
  revokedAt: timestamp("revoked_at").notNull(),
  canonicalRecordDigest: varchar("canonical_record_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_coordination_v2_runtime_revocation_release").on(table.runtimeReleaseId),
  uniqueIndex("uq_coordination_v2_runtime_revocation_request").on(table.requestKey),
  check("coordination_v2_runtime_revocation_reason", sql`${table.reasonCode} ~ '^[A-Z0-9_]{1,128}$'`),
  check("coordination_v2_runtime_revocation_digest", sql`${table.canonicalRecordDigest} ~ '^[0-9a-f]{64}$'`),
]);

// ---------------------------------------------------------------------------
// Local Read-only Worker v1 charters (design bb6c6c06 rev b8fe5e66, §4.1).
// Immutable versions; transitions only draft -> approved -> revoked via CAS.
// body_digest = sha256(canonical JSON of the entire body).
// ---------------------------------------------------------------------------
export const workerCharters = pgTable("worker_charters", {
  id: varchar("id", { length: 36 }).notNull(),
  version: integer("version").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  bodyDigest: varchar("body_digest", { length: 64 }).notNull(),
  approvalState: varchar("approval_state", { length: 16 }).notNull().default('draft'),
  createdBy: varchar("created_by", { length: 255 }).notNull(),
  approvedBy: varchar("approved_by", { length: 255 }),
  approvedAt: timestamp("approved_at"),
  revokedBy: varchar("revoked_by", { length: 255 }),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_worker_charters_id_version").on(table.id, table.version),
  check("worker_charters_version_positive", sql`${table.version} >= 1`),
  check("worker_charters_body_digest", sql`${table.bodyDigest} ~ '^[0-9a-f]{64}$'`),
  check("worker_charters_approval_state", sql`${table.approvalState} IN ('draft', 'approved', 'revoked')`),
  check("worker_charters_approval_consistency", sql`(${table.approvalState} = 'draft' AND ${table.approvedAt} IS NULL AND ${table.revokedAt} IS NULL) OR (${table.approvalState} = 'approved' AND ${table.approvedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.approvalState} = 'revoked' AND ${table.approvedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)`),
]);
export type WorkerCharterRow = typeof workerCharters.$inferSelect;
