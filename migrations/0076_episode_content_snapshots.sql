CREATE TABLE "episode_content_snapshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" varchar NOT NULL,
	"reason" varchar(80) NOT NULL,
	"old_content" text NOT NULL,
	"old_content_sha256" varchar(64) NOT NULL,
	"new_content_sha256" varchar(64) NOT NULL,
	"receipt_list_sha256" varchar(64) NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "episode_content_snapshots_old_hash_matches" CHECK ("episode_content_snapshots"."old_content_sha256" = encode(sha256(convert_to("episode_content_snapshots"."old_content", 'UTF8')), 'hex')),
	CONSTRAINT "episode_content_snapshots_new_sha256" CHECK ("episode_content_snapshots"."new_content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "episode_content_snapshots_receipt_sha256" CHECK ("episode_content_snapshots"."receipt_list_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_episode_content_snapshots_episode_old" ON "episode_content_snapshots" USING btree ("episode_id","old_content_sha256");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_episode_content_snapshot_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'episode content snapshots are insert-only: % is not permitted on %',
    TG_OP,
    TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "episode_content_snapshots_insert_only"
  ON "episode_content_snapshots";
CREATE TRIGGER "episode_content_snapshots_insert_only"
BEFORE UPDATE OR DELETE ON "episode_content_snapshots"
FOR EACH ROW
EXECUTE FUNCTION "reject_episode_content_snapshot_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "episode_content_snapshots_no_truncate"
  ON "episode_content_snapshots";
CREATE TRIGGER "episode_content_snapshots_no_truncate"
BEFORE TRUNCATE ON "episode_content_snapshots"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_episode_content_snapshot_mutation"();
