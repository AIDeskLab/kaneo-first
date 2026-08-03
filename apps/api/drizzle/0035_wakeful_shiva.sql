CREATE TABLE "project_group" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "project_group_id" text;--> statement-breakpoint
ALTER TABLE "project_group" ADD CONSTRAINT "project_group_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_group_workspaceId_idx" ON "project_group" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_project_group_id_project_group_id_fk" FOREIGN KEY ("project_group_id") REFERENCES "public"."project_group"("id") ON DELETE set null ON UPDATE no action;