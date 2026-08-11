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
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_member_clear_task_assignments_before_delete
BEFORE DELETE ON workspace_member
FOR EACH ROW
EXECUTE FUNCTION clear_workspace_member_task_assignments();
