import { and, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { removeLabelFromGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { removeLabelFromGitlab } from "../../plugins/gitlab/utils/sync-label-to-gitlab";
import { removeLabelFromGitHub } from "../../plugins/github/utils/sync-label-to-github";
import { assertProjectAccess } from "../../project-access/assert-project-access";

type LabelRow = typeof labelTable.$inferSelect;
type TaskAssignment = LabelRow & { taskId: string };

// attach inserts a task row and leaves the workspace label's taskId null.
// The id the caller already had is that definition. Remove the copy for the
// requested task, or the only copy when the label is on one task. Do not
// delete the definition, and do not pick a task when several have the label.
async function resolveTaskAssignment(
  label: LabelRow,
  taskId?: string,
): Promise<TaskAssignment> {
  if (label.taskId) {
    if (taskId && taskId !== label.taskId) {
      throw new HTTPException(400, {
        message: "Label is not assigned to a task",
      });
    }
    return { ...label, taskId: label.taskId };
  }

  if (!label.workspaceId) {
    throw new HTTPException(400, {
      message: "Label is not assigned to a task",
    });
  }

  const copies = await db
    .select()
    .from(labelTable)
    .where(
      and(
        eq(labelTable.workspaceId, label.workspaceId),
        eq(labelTable.name, label.name),
        taskId ? eq(labelTable.taskId, taskId) : isNotNull(labelTable.taskId),
      ),
    )
    .limit(taskId ? 1 : 2);

  const copy = copies[0];
  if (copies.length === 1 && copy?.taskId) {
    return { ...copy, taskId: copy.taskId };
  }

  if (!taskId && copies.length > 1) {
    throw new HTTPException(400, {
      message: "Label is assigned to more than one task",
    });
  }

  throw new HTTPException(400, {
    message: "Label is not assigned to a task",
  });
}

async function unassignLabelFromTask(
  id: string,
  userId: string,
  taskId?: string,
) {
  const label = await db.query.labelTable.findFirst({
    where: (label, { eq }) => eq(label.id, id),
  });

  if (!label) {
    throw new HTTPException(404, {
      message: "Label not found",
    });
  }

  const resolvedFromWorkspaceLabel = !label.taskId;
  const assignment = await resolveTaskAssignment(label, taskId);

  const [task] = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, assignment.taskId))
    .limit(1);

  if (!task || task.workspaceId !== assignment.workspaceId) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  // The route middleware checks the project of a task assignment id. A
  // workspace label id has no project, so check the task being detached.
  if (resolvedFromWorkspaceLabel) {
    await assertProjectAccess(userId, task.projectId);
  }

  const [deletedLabel] = await db
    .delete(labelTable)
    .where(eq(labelTable.id, assignment.id))
    .returning();

  if (!deletedLabel) {
    throw new HTTPException(500, {
      message: "Failed to detach label from task",
    });
  }

  if (deletedLabel.taskId) {
    removeLabelFromGitea(deletedLabel.taskId, deletedLabel.name).catch(
      (error) => console.error("Failed to remove label from Gitea:", error),
    );
    removeLabelFromGitlab(deletedLabel.taskId, deletedLabel.name).catch(
      (error) => console.error("Failed to remove label from GitLab:", error),
    );
    removeLabelFromGitHub(deletedLabel.taskId, deletedLabel.name).catch(
      (error) => {
        console.error("Failed to remove label from GitHub:", error);
      },
    );
  }

  await publishEvent("task.label_unassigned", {
    label: deletedLabel,
    task,
    projectId: task.projectId,
    taskId: deletedLabel.taskId,
    userId,
    type: "label_unassigned",
  });

  return deletedLabel;
}

export default unassignLabelFromTask;
