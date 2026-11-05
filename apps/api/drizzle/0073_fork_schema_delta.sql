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
CREATE TABLE "project_group" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_event" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_reminder_sent" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trial_grant" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_billing" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "billing_event" CASCADE;--> statement-breakpoint
DROP TABLE "billing_reminder_sent" CASCADE;--> statement-breakpoint
DROP TABLE "trial_grant" CASCADE;--> statement-breakpoint
DROP TABLE "workspace_billing" CASCADE;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "github_repository_key" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION normalize_github_repository_key(config_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
	parsed jsonb;
	owner text;
	repo_name text;
BEGIN
	IF config_text IS NULL OR btrim(config_text) = '' THEN
		RETURN NULL;
	END IF;

	BEGIN
		parsed := config_text::jsonb;
	EXCEPTION
		WHEN OTHERS THEN
			RETURN NULL;
	END;

	IF jsonb_typeof(parsed -> 'repositoryOwner') <> 'string'
		OR jsonb_typeof(parsed -> 'repositoryName') <> 'string' THEN
		RETURN NULL;
	END IF;

	owner := lower(btrim(parsed ->> 'repositoryOwner'));
	repo_name := lower(btrim(parsed ->> 'repositoryName'));

	IF owner = '' OR repo_name = '' THEN
		RETURN NULL;
	END IF;

	RETURN owner || '/' || repo_name;
END;
$$;--> statement-breakpoint
UPDATE "integration"
SET "github_repository_key" = normalize_github_repository_key("config")
WHERE "type" = 'github'
	AND "is_active" = true;--> statement-breakpoint
UPDATE "integration"
SET
	"is_active" = false,
	"github_repository_key" = NULL,
	"updated_at" = now()
WHERE "type" = 'github'
	AND "is_active" = true
	AND "github_repository_key" IS NULL;--> statement-breakpoint
UPDATE "integration" AS target
SET
	"is_active" = false,
	"github_repository_key" = NULL,
	"updated_at" = now()
FROM (
	SELECT "github_repository_key"
	FROM "integration"
	WHERE "type" = 'github'
		AND "is_active" = true
		AND "github_repository_key" IS NOT NULL
	GROUP BY "github_repository_key"
	HAVING count(*) > 1
) AS duplicates
WHERE target."type" = 'github'
	AND target."is_active" = true
	AND target."github_repository_key" = duplicates."github_repository_key";--> statement-breakpoint
DROP FUNCTION normalize_github_repository_key(text);--> statement-breakpoint
ALTER TABLE "label" ADD COLUMN "source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "project_group_id" text;--> statement-breakpoint
ALTER TABLE "project_group" ADD CONSTRAINT "project_group_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_cleanup_outbox_next_attempt_at_idx" ON "asset_cleanup_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "project_group_workspaceId_idx" ON "project_group" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_project_group_id_project_group_id_fk" FOREIGN KEY ("project_group_id") REFERENCES "public"."project_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_github_repository_key_active_unique" ON "integration" USING btree ("github_repository_key") WHERE "integration"."type" = 'github' and "integration"."is_active" = true and "integration"."github_repository_key" is not null;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_github_active_requires_key_check" CHECK ("integration"."type" <> 'github' OR "integration"."is_active" = false OR "integration"."github_repository_key" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_source_check" CHECK ("label"."source" in ('local', 'github', 'gitea', 'import'));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_start_date_before_due_date_check" CHECK ("task"."start_date" IS NULL OR "task"."due_date" IS NULL OR "task"."start_date" <= "task"."due_date") NOT VALID;--> statement-breakpoint
UPDATE "task" SET "due_date" = "start_date" WHERE "start_date" > "due_date";--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_start_date_before_due_date_check";--> statement-breakpoint
CREATE OR REPLACE FUNCTION clear_workspace_member_task_assignments()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(
		1530,
		hashtext(OLD.workspace_id || ':' || OLD.user_id)
	);

	UPDATE task
	SET assignee_id = NULL
	FROM project
	WHERE task.project_id = project.id
		AND project.workspace_id = OLD.workspace_id
		AND task.assignee_id = OLD.user_id;

	RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_member_clear_task_assignments_before_delete ON workspace_member;--> statement-breakpoint
CREATE TRIGGER workspace_member_clear_task_assignments_before_delete
BEFORE DELETE ON workspace_member
FOR EACH ROW
EXECUTE FUNCTION clear_workspace_member_task_assignments();