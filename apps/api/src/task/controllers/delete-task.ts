import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { cleanupAssetKeys } from "../../storage/cleanup-assets";
import { deleteTaskHierarchy } from "./delete-task-hierarchy";
import getTask from "./get-task";

async function deleteTask(taskId: string, currentUserId: string) {
  const task = await getTask(taskId);

  const [project] = await db
    .select({ workspaceId: projectTable.workspaceId })
    .from(projectTable)
    .where(eq(projectTable.id, task.projectId))
    .limit(1);

  if (!project?.workspaceId) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const { deletedTasks, deletedRelations, assetKeys } = await db.transaction(
    async (tx) =>
      deleteTaskHierarchy(tx, project.workspaceId, [taskId]),
  );

  if (deletedTasks.length === 0) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const projectByTaskId = new Map(
    deletedTasks.map((deleted) => [deleted.id, deleted.projectId]),
  );

  for (const deleted of deletedTasks) {
    await publishEvent("task.deleted", {
      taskId: deleted.id,
      projectId: deleted.projectId,
      userId: currentUserId,
      title: deleted.title,
    });
  }

  for (const relation of deletedRelations) {
    const projectId =
      projectByTaskId.get(relation.sourceTaskId) ??
      projectByTaskId.get(relation.targetTaskId) ??
      task.projectId;

    await publishEvent("task-relation.deleted", {
      projectId,
      userId: currentUserId,
      taskId: projectByTaskId.has(relation.sourceTaskId)
        ? relation.sourceTaskId
        : relation.targetTaskId,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
    });
  }

  // Fire-and-forget S3 cleanup after successful DB delete
  cleanupAssetKeys(assetKeys).catch(() => {});

  return task;
}

export default deleteTask;
