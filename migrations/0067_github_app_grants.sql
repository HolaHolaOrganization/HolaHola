CREATE TABLE "github_app_grants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" varchar(80) NOT NULL,
	"app_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"proposed_by" varchar(120) NOT NULL,
	"decided_by" varchar(120),
	"decided_at" timestamp,
	"expires_at" timestamp,
	"revoked_by" varchar(120),
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_grants_state_valid" CHECK ("github_app_grants"."state" in ('pending', 'active', 'disabled', 'rejected', 'revoked')),
	CONSTRAINT "github_app_grants_ids_positive" CHECK ("github_app_grants"."app_id" > 0 and "github_app_grants"."installation_id" > 0),
	CONSTRAINT "github_app_grants_live_has_expiry" CHECK ("github_app_grants"."state" not in ('active', 'disabled') or "github_app_grants"."expires_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "github_token_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"success" boolean NOT NULL,
	"actor" varchar(80),
	"grant_id" varchar,
	"app_id" bigint,
	"installation_id" bigint,
	"reason" varchar(160),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_app_grants_live_actor" ON "github_app_grants" USING btree ("actor") WHERE "github_app_grants"."state" in ('active', 'disabled');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_app_grants_live_app" ON "github_app_grants" USING btree ("app_id") WHERE "github_app_grants"."state" in ('active', 'disabled');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_app_grants_live_installation" ON "github_app_grants" USING btree ("installation_id") WHERE "github_app_grants"."state" in ('active', 'disabled');--> statement-breakpoint
CREATE INDEX "idx_github_app_grants_state" ON "github_app_grants" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_github_token_audit_actor" ON "github_token_audit_events" USING btree ("actor","created_at");--> statement-breakpoint
CREATE INDEX "idx_github_token_audit_grant" ON "github_token_audit_events" USING btree ("grant_id","created_at");