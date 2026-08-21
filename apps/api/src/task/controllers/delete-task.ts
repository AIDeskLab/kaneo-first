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
    async (tx) => deleteTaskHierarchy(tx, project.workspaceId, [taskId]),
  );

  if (deletedTasks.length === 0) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const deletedTaskIds = new Set(deletedTasks.map((deleted) => deleted.id));

  for (const deleted of deletedTasks) {
    await publishEvent("task.deleted", {
      taskId: deleted.id,
      projectId: deleted.projectId,
      userId: currentUserId,
      title: deleted.title,
    });
  }

  for (const relation of deletedRelations) {
    const projectIds = [
      ...new Set([relation.sourceProjectId, relation.targetProjectId]),
    ].sort();
    const incidentTaskId = deletedTaskIds.has(relation.sourceTaskId)
      ? relation.sourceTaskId
      : relation.targetTaskId;

    for (const projectId of projectIds) {
      await publishEvent("task-relation.deleted", {
        id: relation.id,
        sourceTaskId: relation.sourceTaskId,
        targetTaskId: relation.targetTaskId,
        relationType: relation.relationType,
        createdAt: relation.createdAt,
        userId: currentUserId,
        taskId: incidentTaskId,
        projectId,
      });
    }
  }

  // Fire-and-forget S3 cleanup after successful DB delete
  cleanupAssetKeys(assetKeys).catch(() => {});

  return task;
}

export default deleteTask;
