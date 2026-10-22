CREATE TABLE "claude_code_projection_shadow" (
	"run_id" varchar(64) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"opening_position" integer NOT NULL,
	"capture_id" varchar(160) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"state" varchar(32) NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"version_sha256" varchar(64) NOT NULL,
	"user_sha256" varchar(64) NOT NULL,
	"reply_sha256" varchar(64) NOT NULL,
	"comparison" varchar(32) NOT NULL,
	"comparison_detail" varchar(120),
	"sides_verified" boolean DEFAULT false NOT NULL,
	"existing_row_id" varchar,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "claude_code_projection_shadow_pk" PRIMARY KEY("run_id","session_id","opening_position"),
	CONSTRAINT "claude_code_projection_shadow_state" CHECK ("claude_code_projection_shadow"."state" in ('certified', 'provisional-candidate', 'open', 'retained')),
	CONSTRAINT "claude_code_projection_shadow_comparison" CHECK ("claude_code_projection_shadow"."comparison" in ('body-match', 'mismatch', 'missing', 'ambiguous', 'not-applicable'))
);
--> statement-breakpoint
CREATE INDEX "idx_claude_code_shadow_session" ON "claude_code_projection_shadow" USING btree ("session_id","created_at");