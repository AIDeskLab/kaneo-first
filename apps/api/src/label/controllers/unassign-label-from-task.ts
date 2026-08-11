import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { removeLabelFromGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { removeLabelFromGitHub } from "../../plugins/github/utils/sync-label-to-github";
import { lockWorkspaceLabels } from "./workspace-label-lock";

async function unassignLabelFromTask(id: string, userId: string) {
  const label = await db.query.labelTable.findFirst({
    where: (label, { eq }) => eq(label.id, id),
  });

  if (!label) {
    throw new HTTPException(404, {
      message: "Label not found",
    });
  }

  if (!label.taskId) {
    throw new HTTPException(400, {
      message: "Label is not assigned to a task",
    });
  }

  const [task] = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, label.taskId))
    .limit(1);

  if (!task) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const deletedLabel = await db.transaction(async (tx) => {
    await lockWorkspaceLabels(tx, task.workspaceId, [label.name]);
    const current = await tx.query.labelTable.findFirst({
      where: (row, { eq }) => eq(row.id, id),
    });
    if (!current?.taskId)
      throw new HTTPException(404, { message: "Label not found" });
    await removeLabelFromGitHub(current.taskId, current.name);
    await removeLabelFromGitea(current.taskId, current.name);
    const [deleted] = await tx
      .delete(labelTable)
      .where(eq(labelTable.id, id))
      .returning();
    return deleted;
  });

  if (!deletedLabel) {
    throw new HTTPException(500, {
      message: "Failed to detach label from task",
    });
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
