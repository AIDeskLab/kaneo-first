ALTER TABLE "label" ADD COLUMN "source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
-- Existing task labels remain local because legacy rows contain no reliable
-- provider-level provenance. Task linkage alone cannot distinguish labels
-- imported from Gitea from labels created locally on the same task.
ALTER TABLE "label" ADD CONSTRAINT "label_source_check" CHECK ("label"."source" in ('local', 'github', 'gitea', 'import'));
