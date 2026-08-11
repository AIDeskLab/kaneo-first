CREATE TABLE "mcp_oauth_state" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "project" p SET "position" = sub.rn
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "created_at", "id") - 1 AS rn
	FROM "project"
) sub
WHERE p."id" = sub."id";--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_state_kind_key_uidx" ON "mcp_oauth_state" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "mcp_oauth_state_expiresAt_idx" ON "mcp_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "project_workspaceId_position_idx" ON "project" USING btree ("workspace_id","position");
