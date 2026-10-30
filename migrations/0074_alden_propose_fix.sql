ALTER TYPE "public"."proposed_change_status" ADD VALUE 'approved_pending_review';--> statement-breakpoint
ALTER TYPE "public"."proposed_change_status" ADD VALUE 'review_blocked';--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "confidence" varchar;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "pin_kind" varchar;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "pin_commit" varchar;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "pin_source_digest" text;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "pin_files" jsonb;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "pattern_id" varchar;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "notify_state" varchar;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "notify_error" text;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "notify_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposed_code_changes" ADD COLUMN "build_queue_id" varchar;--> statement-breakpoint
ALTER TABLE "proposed_code_changes" ADD CONSTRAINT "proposed_code_changes_build_queue_id_build_queue_id_fk" FOREIGN KEY ("build_queue_id") REFERENCES "public"."build_queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_confidence_valid" CHECK ("build_queue"."confidence" IS NULL OR "build_queue"."confidence" IN ('low', 'medium', 'high'));--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_pin_kind_valid" CHECK ("build_queue"."pin_kind" IS NULL OR "build_queue"."pin_kind" IN ('release', 'dev-head'));--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_pin_complete" CHECK (("build_queue"."pin_kind" IS NULL) = ("build_queue"."pin_commit" IS NULL) AND ("build_queue"."pin_kind" IS NULL) = ("build_queue"."pin_files" IS NULL));--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_pin_has_diff" CHECK ("build_queue"."pin_kind" IS NULL OR "build_queue"."diff" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_pin_commit_sha" CHECK ("build_queue"."pin_commit" IS NULL OR "build_queue"."pin_commit" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_release_pin_digest" CHECK ("build_queue"."pin_kind" IS DISTINCT FROM 'release' OR "build_queue"."pin_source_digest" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_pin_requires_high" CHECK ("build_queue"."pin_kind" IS NULL OR "build_queue"."confidence" = 'high');--> statement-breakpoint
ALTER TABLE "build_queue" ADD CONSTRAINT "build_queue_notify_state_valid" CHECK ("build_queue"."notify_state" IS NULL OR "build_queue"."notify_state" IN ('pending', 'delivered', 'failed'));