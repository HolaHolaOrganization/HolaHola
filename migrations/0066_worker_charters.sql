CREATE TABLE "worker_charters" (
	"id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"body_digest" varchar(64) NOT NULL,
	"approval_state" varchar(16) DEFAULT 'draft' NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"revoked_by" varchar(255),
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "worker_charters_version_positive" CHECK ("worker_charters"."version" >= 1),
	CONSTRAINT "worker_charters_body_digest" CHECK ("worker_charters"."body_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "worker_charters_approval_state" CHECK ("worker_charters"."approval_state" IN ('draft', 'approved', 'revoked')),
	CONSTRAINT "worker_charters_approval_consistency" CHECK (("worker_charters"."approval_state" = 'draft' AND "worker_charters"."approved_at" IS NULL AND "worker_charters"."revoked_at" IS NULL) OR ("worker_charters"."approval_state" = 'approved' AND "worker_charters"."approved_at" IS NOT NULL AND "worker_charters"."revoked_at" IS NULL) OR ("worker_charters"."approval_state" = 'revoked' AND "worker_charters"."approved_at" IS NOT NULL AND "worker_charters"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worker_charters_id_version" ON "worker_charters" USING btree ("id","version");