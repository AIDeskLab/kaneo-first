ALTER TABLE "integration" ADD COLUMN "github_repository_key" text;
--> statement-breakpoint
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
$$;
--> statement-breakpoint
UPDATE "integration"
SET "github_repository_key" = normalize_github_repository_key("config")
WHERE "type" = 'github'
	AND "is_active" = true;
--> statement-breakpoint
UPDATE "integration"
SET
	"is_active" = false,
	"github_repository_key" = NULL,
	"updated_at" = now()
WHERE "type" = 'github'
	AND "is_active" = true
	AND "github_repository_key" IS NULL;
--> statement-breakpoint
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
	AND target."github_repository_key" = duplicates."github_repository_key";
--> statement-breakpoint
DROP FUNCTION normalize_github_repository_key(text);
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_github_repository_key_active_unique" ON "integration" USING btree ("github_repository_key") WHERE "integration"."type" = 'github' and "integration"."is_active" = true and "integration"."github_repository_key" is not null;
--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_github_active_requires_key_check" CHECK ("integration"."type" <> 'github' OR "integration"."is_active" = false OR "integration"."github_repository_key" IS NOT NULL);
