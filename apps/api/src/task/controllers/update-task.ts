import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { deleteOrphanedAssets } from "../../storage/cleanup-assets";
import { lockWorkspaceTaskHierarchy } from "./task-cascade";
import { updateTaskHierarchyStatus } from "./update-task-hierarchy-status";
import {
  lockWorkspaceAssignees,
  requireWorkspaceAssignees,
} from "./workspace-assignee-lock";

async function updateTask(
  id: string,
  title: string,
  status: string,
  startDate: Date | undefined,
  dueDate: Date | undefined,
  projectId: string,
  description: string,
  priority: string,
  position: number,
  userId?: string,
  currentUserId?: string,
  authorizedAssignee?: { userId: string | null },
) {
  const [existingTask] = await db
    .select({
      id: taskTable.id,
      description: taskTable.description,
      status: taskTable.status,
      projectId: taskTable.projectId,
    })
    .from(taskTable)
    .where(eq(taskTable.id, id))
    .limit(1);

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  if (projectId !== existingTask.projectId) {
    throw new HTTPException(400, {
      message: "Use the task move endpoint to move tasks between projects",
    });
  }

  const normalizedUserId = userId?.trim() || undefined;
  const project = await db.query.projectTable.findFirst({
    columns: { workspaceId: true },
    where: eq(projectTable.id, projectId),
  });
  if (!project) throw new HTTPException(404, { message: "Project not found" });

  const { changedTasks, refreshProjectIds, updatedTask } = await db.transaction(
    async (tx) => {
      await lockWorkspaceTaskHierarchy(tx, project.workspaceId);

      const requestedAssigneeId = normalizedUserId ?? null;
      if (requestedAssigneeId) {
        await lockWorkspaceAssignees(tx, project.workspaceId, [
          requestedAssigneeId,
        ]);
        await requireWorkspaceAssignees(tx, project.workspaceId, [
          requestedAssigneeId,
        ]);
      }

      const [lockedTask] = await tx
        .select({
          userId: taskTable.userId,
          projectId: taskTable.projectId,
        })
        .from(taskTable)
        .where(eq(taskTable.id, id))
        .for("update")
        .limit(1);
      if (!lockedTask)
        throw new HTTPException(404, { message: "Task not found" });
      if (
        authorizedAssignee &&
        lockedTask.userId !== authorizedAssignee.userId
      ) {
        throw new HTTPException(409, {
          message: "Task assignee changed while the task was being updated",
        });
      }
      if (lockedTask.projectId !== projectId) {
        throw new HTTPException(409, {
          message: "Task project changed while the task was being updated",
        });
      }

      // Status cascades to all recursive "subtask" descendants; other fields
      // (priority/assignee/dates/etc.) apply only to the root task.
      const hierarchyResult = await updateTaskHierarchyStatus(
        tx,
        project.workspaceId,
        [id],
        status,
      );

      const [task] = await tx
        .update(taskTable)
        .set({
          title,
          startDate: startDate || null,
          dueDate: dueDate || null,
          description,
          priority,
          position,
          userId: requestedAssigneeId,
        })
        .where(eq(taskTable.id, id))
        .returning();

      if (!task) {
        throw new HTTPException(404, { message: "Task not found" });
      }

      return { ...hierarchyResult, updatedTask: task };
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

  await publishEvent("task.updated", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    title: updatedTask.title,
    status: updatedTask.status,
    userId: currentUserId,
  });

  if (existingTask.description !== description) {
    deleteOrphanedAssets(existingTask.description, description, {
      taskId: id,
    }).catch(() => {});
  }

  return updatedTask;
}

export default updateTask;
