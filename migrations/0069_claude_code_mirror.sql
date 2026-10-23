CREATE TABLE "claude_code_block_confirmations" (
	"session_id" varchar(64) NOT NULL,
	"block_index" integer NOT NULL,
	"confirmed_local_digest" varchar(64) NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "claude_code_block_confirmations_pk" PRIMARY KEY("session_id","block_index")
);
--> statement-breakpoint
CREATE TABLE "claude_code_entry_contents" (
	"session_id" varchar(64) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"entry" jsonb NOT NULL,
	"byte_length" integer NOT NULL,
	"first_seen" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "claude_code_entry_contents_pk" PRIMARY KEY("session_id","content_sha256"),
	CONSTRAINT "claude_code_entry_contents_sha" CHECK ("claude_code_entry_contents"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "claude_code_entry_observations" (
	"session_id" varchar(64) NOT NULL,
	"source_position" integer NOT NULL,
	"entry_uuid" varchar(64) DEFAULT '' NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor" varchar(80) NOT NULL,
	"first_seen" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "claude_code_observations_pk" PRIMARY KEY("session_id","source_position","entry_uuid","content_sha256"),
	CONSTRAINT "claude_code_entry_observations_position" CHECK ("claude_code_entry_observations"."source_position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "claude_code_hook_evidence" (
	"occurrence_id" varchar(64) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"text" text NOT NULL,
	"transcript_line_count" integer,
	"conflict" boolean DEFAULT false NOT NULL,
	"actor" varchar(80) NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "claude_code_hook_evidence_pk" PRIMARY KEY("occurrence_id","content_sha256"),
	CONSTRAINT "claude_code_hook_evidence_kind" CHECK ("claude_code_hook_evidence"."kind" in ('submitted-prompt', 'last-assistant-message'))
);
--> statement-breakpoint
CREATE TABLE "claude_code_session_roots" (
	"session_id" varchar(64) PRIMARY KEY NOT NULL,
	"actor" varchar(80) NOT NULL,
	"confirmed_root_digest" varchar(64) NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claude_code_sync_challenges" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"actor" varchar(80) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"consumed_at" timestamp with time zone,
	"observed_root_digest" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "claude_code_entry_observations" ADD CONSTRAINT "claude_code_observations_content_fk" FOREIGN KEY ("session_id","content_sha256") REFERENCES "public"."claude_code_entry_contents"("session_id","content_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_claude_code_observations_uuid" ON "claude_code_entry_observations" USING btree ("session_id","entry_uuid");--> statement-breakpoint
CREATE INDEX "idx_claude_code_hook_evidence_session" ON "claude_code_hook_evidence" USING btree ("session_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_claude_code_challenges_session" ON "claude_code_sync_challenges" USING btree ("session_id","issued_at");