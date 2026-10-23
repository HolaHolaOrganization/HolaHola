ALTER TABLE "claude_code_block_confirmations" ADD COLUMN "filter_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_code_entry_observations" ADD COLUMN "filter_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_code_projection_shadow" ADD COLUMN "filter_version" smallint;--> statement-breakpoint
ALTER TABLE "claude_code_projection_shadow" ADD COLUMN "rules_version" smallint;--> statement-breakpoint
ALTER TABLE "claude_code_projection_shadow" ADD COLUMN "v1_only_positions" integer;--> statement-breakpoint
ALTER TABLE "claude_code_projection_shadow" ADD COLUMN "excluded_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "claude_code_block_confirmations" DROP CONSTRAINT "claude_code_block_confirmations_pk";
--> statement-breakpoint
ALTER TABLE "claude_code_block_confirmations" ADD CONSTRAINT "claude_code_block_confirmations_pk" PRIMARY KEY("session_id","block_index","filter_version");--> statement-breakpoint
ALTER TABLE "claude_code_entry_observations" DROP CONSTRAINT "claude_code_observations_pk";
--> statement-breakpoint
ALTER TABLE "claude_code_entry_observations" ADD CONSTRAINT "claude_code_observations_pk" PRIMARY KEY("session_id","source_position","entry_uuid","content_sha256","filter_version");