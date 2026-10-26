CREATE TABLE "alden_exchange_labels" (
	"label_key" varchar(64) PRIMARY KEY NOT NULL,
	"conversation_id" varchar NOT NULL,
	"caller_message_id" varchar NOT NULL,
	"caller_sha256" varchar(64) NOT NULL,
	"reply_message_id" varchar,
	"reply_sha256" varchar(64),
	"policy_version" varchar(40) NOT NULL,
	"label" varchar(20) NOT NULL,
	"reason" varchar(200) NOT NULL,
	"prefilter_density" real,
	"classifier_model" varchar(80),
	"prompt_sha256" varchar(64),
	"labelled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alden_exchange_labels_conversation_idx" ON "alden_exchange_labels" USING btree ("conversation_id");