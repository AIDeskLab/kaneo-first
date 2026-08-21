CREATE TABLE "asset_cleanup_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_cleanup_outbox_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE INDEX "asset_cleanup_outbox_next_attempt_at_idx" ON "asset_cleanup_outbox" USING btree ("next_attempt_at");
