CREATE TABLE "central_read_grants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_id" varchar(120) NOT NULL,
	"actor" varchar(80) NOT NULL,
	"scope" varchar(80) NOT NULL,
	"granted_by" varchar(120) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "central_read_grant_scope" CHECK ("central_read_grants"."scope" = 'central-records:read'),
	CONSTRAINT "central_read_grant_expiry" CHECK ("central_read_grants"."expires_at" > "central_read_grants"."created_at")
);
--> statement-breakpoint
ALTER TABLE "coordination_runtime_credentials" ADD COLUMN "central_grant_id" varchar;--> statement-breakpoint
ALTER TABLE "central_read_grants" ADD CONSTRAINT "central_read_grants_runtime_id_coordination_runtime_registrations_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."coordination_runtime_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_central_read_live_grant" ON "central_read_grants" USING btree ("runtime_id","scope") WHERE "central_read_grants"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "coordination_runtime_credentials" ADD CONSTRAINT "coordination_runtime_credentials_central_grant_id_central_read_grants_id_fk" FOREIGN KEY ("central_grant_id") REFERENCES "public"."central_read_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_central_expiry_warning_grant" ON "coordination_credential_audit_events" USING btree (("metadata"->>'grantId')) WHERE "coordination_credential_audit_events"."event_type" = 'central_expiry_warned' AND "coordination_credential_audit_events"."success" = true;--> statement-breakpoint
ALTER TABLE "coordination_runtime_credentials" ADD CONSTRAINT "coordination_central_credential_binding" CHECK (
    ("coordination_runtime_credentials"."central_grant_id" IS NOT NULL AND "coordination_runtime_credentials"."capabilities" = ARRAY['central-records:read']::text[])
    OR ("coordination_runtime_credentials"."central_grant_id" IS NULL AND NOT ("coordination_runtime_credentials"."capabilities" && ARRAY['central-records:read','central-documents:read']::text[])));