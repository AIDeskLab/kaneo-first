ALTER TABLE "task" ADD CONSTRAINT "task_start_date_before_due_date_check" CHECK ("task"."start_date" IS NULL OR "task"."due_date" IS NULL OR "task"."start_date" <= "task"."due_date") NOT VALID;
--> statement-breakpoint
UPDATE "task" SET "due_date" = "start_date" WHERE "start_date" > "due_date";
--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_start_date_before_due_date_check";
