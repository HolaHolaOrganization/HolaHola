CREATE TABLE "agent_feed_actor_receipts" (
	"actor" varchar(80) NOT NULL,
	"row_id" varchar NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"xid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "agent_feed_actor_receipts_pk" PRIMARY KEY("actor","row_id","content_sha256"),
	CONSTRAINT "agent_feed_actor_receipts_kind" CHECK ("agent_feed_actor_receipts"."kind" in ('baseline', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "agent_feed_enrollments" (
	"actor" varchar(80) PRIMARY KEY NOT NULL,
	"enrollment_xid" text NOT NULL,
	"baseline_count" integer NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_feed_registrations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" varchar(80) NOT NULL,
	"runtime_session_id" varchar(128) NOT NULL,
	"snapshot" text NOT NULL,
	"notice_attempts" integer DEFAULT 0 NOT NULL,
	"bootstrap_at" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "agent_feed_registrations_attempts" CHECK ("agent_feed_registrations"."notice_attempts" between 0 and 12)
);
--> statement-breakpoint
CREATE TABLE "agent_feed_served" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" varchar NOT NULL,
	"kind" varchar(16) NOT NULL,
	"items" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "agent_feed_served_kind" CHECK ("agent_feed_served"."kind" in ('page', 'bootstrap', 'notice'))
);
--> statement-breakpoint
CREATE TABLE "agent_feed_session_receipts" (
	"registration_id" varchar NOT NULL,
	"receipt_kind" varchar(16) NOT NULL,
	"item_kind" varchar(16) NOT NULL,
	"item_id" varchar NOT NULL,
	"item_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "agent_feed_session_receipts_pk" PRIMARY KEY("registration_id","receipt_kind","item_kind","item_id","item_sha256"),
	CONSTRAINT "agent_feed_session_receipts_kind" CHECK ("agent_feed_session_receipts"."receipt_kind" in ('page-notified', 'notice-seen', 'fetched', 'read')),
	CONSTRAINT "agent_feed_session_receipts_item" CHECK ("agent_feed_session_receipts"."item_kind" in ('canonical', 'provisional'))
);
--> statement-breakpoint
ALTER TABLE "agent_feed_served" ADD CONSTRAINT "agent_feed_served_reg_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."agent_feed_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_feed_session_receipts" ADD CONSTRAINT "agent_feed_session_receipts_reg_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."agent_feed_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_feed_registrations_live" ON "agent_feed_registrations" USING btree ("actor","runtime_session_id") WHERE "agent_feed_registrations"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "idx_agent_feed_served_registration" ON "agent_feed_served" USING btree ("registration_id");