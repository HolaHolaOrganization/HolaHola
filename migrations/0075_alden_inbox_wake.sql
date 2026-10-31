CREATE TABLE "alden_wake_attempt_audit" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" varchar NOT NULL,
	"claim_epoch" integer NOT NULL,
	"worker_id" varchar(120) NOT NULL,
	"result" varchar(20) NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alden_wake_attempt_audit_result_valid" CHECK ("alden_wake_attempt_audit"."result" IN ('published', 'superseded', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "alden_wake_attempts" (
	"item_id" varchar PRIMARY KEY NOT NULL,
	"item_kind" varchar(20) DEFAULT 'addressed' NOT NULL,
	"inbox_item_id" varchar,
	"watch_item_id" varchar,
	"event_id" varchar NOT NULL,
	"event_global_sequence" bigint NOT NULL,
	"state" varchar(30) NOT NULL,
	"claimed_by" varchar(120),
	"claimed_at" timestamp,
	"lease_until" timestamp,
	"claim_day" date,
	"effect_key" varchar(200) NOT NULL,
	"target_thread_id" varchar NOT NULL,
	"target_sender" varchar(80) NOT NULL,
	"reply_event_id" varchar,
	"covered_by" varchar,
	"covered_reply_event_id" varchar,
	"tools_used" text[],
	"error_class" varchar(120),
	"notes" text,
	"decided_by" varchar(120),
	"decided_at" timestamp,
	"claim_epoch" integer DEFAULT 0 NOT NULL,
	"reply_payload_sha256" varchar(64),
	"requested_covers" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alden_wake_attempts_one_source" CHECK (("alden_wake_attempts"."item_kind" = 'addressed' AND "alden_wake_attempts"."inbox_item_id" IS NOT NULL AND "alden_wake_attempts"."watch_item_id" IS NULL AND "alden_wake_attempts"."item_id" = "alden_wake_attempts"."inbox_item_id")
    OR ("alden_wake_attempts"."item_kind" = 'observe' AND "alden_wake_attempts"."watch_item_id" IS NOT NULL AND "alden_wake_attempts"."inbox_item_id" IS NULL AND "alden_wake_attempts"."item_id" = "alden_wake_attempts"."watch_item_id")),
	CONSTRAINT "alden_wake_attempts_state_valid" CHECK ("alden_wake_attempts"."state" IN ('eligible', 'claimed', 'replied', 'declined', 'needs_david', 'failed', 'uncertain', 'conflict', 'manual', 'covered', 'handled_in_chat', 'history', 'observed')),
	CONSTRAINT "alden_wake_attempts_kind_valid" CHECK ("alden_wake_attempts"."item_kind" IN ('addressed', 'observe')),
	CONSTRAINT "alden_wake_attempts_observed_kind" CHECK ("alden_wake_attempts"."state" <> 'observed' OR "alden_wake_attempts"."item_kind" = 'observe'),
	CONSTRAINT "alden_wake_attempts_observe_never_needs_david" CHECK ("alden_wake_attempts"."item_kind" <> 'observe' OR "alden_wake_attempts"."state" <> 'needs_david'),
	CONSTRAINT "alden_wake_attempts_claim_complete" CHECK ("alden_wake_attempts"."state" <> 'claimed' OR ("alden_wake_attempts"."claimed_by" IS NOT NULL AND "alden_wake_attempts"."claimed_at" IS NOT NULL AND "alden_wake_attempts"."lease_until" IS NOT NULL)),
	CONSTRAINT "alden_wake_attempts_reply_sha256" CHECK ("alden_wake_attempts"."reply_payload_sha256" IS NULL OR "alden_wake_attempts"."reply_payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "alden_wake_attempts_epoch_nonnegative" CHECK ("alden_wake_attempts"."claim_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "alden_wake_control" (
	"id" varchar PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"activated_at" timestamp,
	"cutoff_global_sequence" bigint,
	"updated_by" varchar(120),
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alden_wake_control_single_row" CHECK ("alden_wake_control"."id" = 'alden')
);
--> statement-breakpoint
CREATE TABLE "alden_wake_notice_outbox" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" varchar NOT NULL,
	"state_reported" varchar(30) NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"notification_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alden_wake_notice_outbox_status_valid" CHECK ("alden_wake_notice_outbox"."status" IN ('pending', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "alden_wake_thread_pauses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar NOT NULL,
	"paused_at" timestamp NOT NULL,
	"reason" varchar(40) NOT NULL,
	"evidence" jsonb NOT NULL,
	"resume_at" timestamp NOT NULL,
	"cooldown_minutes" integer NOT NULL,
	"resumed_at" timestamp,
	"resumed_by" varchar(120),
	"resume_event_id" varchar,
	CONSTRAINT "alden_wake_thread_pauses_reason_valid" CHECK ("alden_wake_thread_pauses"."reason" IN ('repeating_exchange')),
	CONSTRAINT "alden_wake_thread_pauses_cooldown_bounds" CHECK ("alden_wake_thread_pauses"."cooldown_minutes" BETWEEN 30 AND 240),
	CONSTRAINT "alden_wake_thread_pauses_resume_after_pause" CHECK ("alden_wake_thread_pauses"."resume_at" > "alden_wake_thread_pauses"."paused_at"),
	CONSTRAINT "alden_wake_thread_pauses_resumed_complete" CHECK (("alden_wake_thread_pauses"."resumed_at" IS NULL) = ("alden_wake_thread_pauses"."resumed_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "coordination_thread_watchers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar NOT NULL,
	"watcher" varchar(80) NOT NULL,
	"added_by" varchar(120) NOT NULL,
	"reason" text NOT NULL,
	"from_global_sequence" bigint NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"removed_at" timestamp,
	"removed_by" varchar(120),
	CONSTRAINT "coordination_thread_watchers_no_self_add" CHECK ("coordination_thread_watchers"."added_by" <> "coordination_thread_watchers"."watcher"),
	CONSTRAINT "coordination_thread_watchers_reason_nonempty" CHECK (length(trim("coordination_thread_watchers"."reason")) > 0),
	CONSTRAINT "coordination_thread_watchers_removed_complete" CHECK (("coordination_thread_watchers"."removed_at" IS NULL) = ("coordination_thread_watchers"."removed_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "coordination_watch_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" varchar NOT NULL,
	"watcher" varchar(80) NOT NULL,
	"event_id" varchar NOT NULL,
	"thread_id" varchar NOT NULL,
	"event_global_sequence" bigint NOT NULL,
	"sender" varchar(80) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coordination_watch_items_not_own_event" CHECK ("coordination_watch_items"."sender" <> "coordination_watch_items"."watcher")
);
--> statement-breakpoint
ALTER TABLE "alden_wake_attempt_audit" ADD CONSTRAINT "alden_wake_attempt_audit_item_id_alden_wake_attempts_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."alden_wake_attempts"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alden_wake_attempts" ADD CONSTRAINT "alden_wake_attempts_inbox_item_id_coordination_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."coordination_inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alden_wake_attempts" ADD CONSTRAINT "alden_wake_attempts_watch_item_id_coordination_watch_items_id_fk" FOREIGN KEY ("watch_item_id") REFERENCES "public"."coordination_watch_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alden_wake_attempts" ADD CONSTRAINT "alden_wake_attempts_event_id_coordination_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."coordination_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alden_wake_notice_outbox" ADD CONSTRAINT "alden_wake_notice_outbox_item_id_alden_wake_attempts_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."alden_wake_attempts"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alden_wake_thread_pauses" ADD CONSTRAINT "alden_wake_thread_pauses_thread_id_coordination_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coordination_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_thread_watchers" ADD CONSTRAINT "coordination_thread_watchers_thread_id_coordination_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coordination_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_watch_items" ADD CONSTRAINT "coordination_watch_items_watch_id_coordination_thread_watchers_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."coordination_thread_watchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_watch_items" ADD CONSTRAINT "coordination_watch_items_event_id_coordination_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."coordination_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_watch_items" ADD CONSTRAINT "coordination_watch_items_thread_id_coordination_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coordination_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alden_wake_attempt_audit_item" ON "alden_wake_attempt_audit" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alden_wake_attempts_effect_key" ON "alden_wake_attempts" USING btree ("effect_key");--> statement-breakpoint
CREATE INDEX "idx_alden_wake_attempts_state" ON "alden_wake_attempts" USING btree ("state","event_global_sequence");--> statement-breakpoint
CREATE INDEX "idx_alden_wake_attempts_thread" ON "alden_wake_attempts" USING btree ("target_thread_id");--> statement-breakpoint
CREATE INDEX "idx_alden_wake_attempts_event" ON "alden_wake_attempts" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alden_wake_notice_outbox_dedupe" ON "alden_wake_notice_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_alden_wake_notice_outbox_status" ON "alden_wake_notice_outbox" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alden_wake_thread_pauses_active" ON "alden_wake_thread_pauses" USING btree ("thread_id") WHERE "alden_wake_thread_pauses"."resumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_coordination_thread_watchers_active" ON "coordination_thread_watchers" USING btree ("thread_id","watcher") WHERE "coordination_thread_watchers"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_coordination_watch_items_watcher_event" ON "coordination_watch_items" USING btree ("watcher","event_id");--> statement-breakpoint
CREATE INDEX "idx_coordination_watch_items_thread_sequence" ON "coordination_watch_items" USING btree ("thread_id","event_global_sequence");--> statement-breakpoint
-- Ships on (founder decision, wake design eb2ed6bf r11): the single control row is created enabled. It is an emergency stop, not a launch gate; ON CONFLICT DO NOTHING means a re-run never re-enables a stopped wake.
INSERT INTO "alden_wake_control" ("id", "enabled", "updated_by") VALUES ('alden', true, 'migration-0075') ON CONFLICT ("id") DO NOTHING;
