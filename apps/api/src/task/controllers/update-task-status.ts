import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { updateTaskHierarchyStatus } from "./update-task-hierarchy-status";

async function updateTaskStatus({
  id,
  status,
  currentUserId,
}: {
  id: string;
  status: string;
  currentUserId: string;
}) {
  const [taskContext] = await db
    .select({ workspaceId: projectTable.workspaceId })
    .from(taskTable)
    .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(eq(taskTable.id, id))
    .limit(1);

  if (!taskContext?.workspaceId) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const { changedTasks, refreshProjectIds, updatedTask } = await db.transaction(
    async (tx) => {
      const result = await updateTaskHierarchyStatus(
        tx,
        taskContext.workspaceId,
        [id],
        status,
      );

      const [rootTask] = await tx
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, id))
        .limit(1);

      if (!rootTask) {
        throw new HTTPException(404, {
          message: "Task not found",
        });
      }

      return { ...result, updatedTask: rootTask };
    },
  );

  for (const changed of changedTasks) {
    await publishEvent("task.status_changed", {
      taskId: changed.id,
      projectId: changed.projectId,
      userId: currentUserId,
      oldStatus: changed.oldStatus,
      newStatus: changed.newStatus,
      title: changed.title,
      assigneeId: changed.assigneeId,
      type: "status_changed",
    });
  }

  for (const refreshProjectId of refreshProjectIds) {
    await publishEvent("task-relation.refresh", {
      projectId: refreshProjectId,
      userId: currentUserId,
    });
  }

  return updatedTask;
}

export default updateTaskStatus;
