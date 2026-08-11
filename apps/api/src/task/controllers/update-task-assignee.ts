import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  lockWorkspaceAssignees,
  requireWorkspaceAssignees,
} from "./workspace-assignee-lock";

async function updateTaskAssignee({
  id,
  userId,
  currentUserId,
}: {
  id: string;
  userId: string | null;
  currentUserId: string;
}) {
  const nextAssigneeId = userId?.trim() || null;
  const taskContext = await db
    .select({ workspaceId: projectTable.workspaceId })
    .from(taskTable)
    .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(eq(taskTable.id, id))
    .limit(1);
  const workspaceId = taskContext[0]?.workspaceId;
  if (!workspaceId) throw new HTTPException(404, { message: "Task not found" });
  let oldAssigneeId: string | null = null;
  let newAssigneeName: string | undefined;
  const updatedTask = await db.transaction(async (tx) => {
    if (nextAssigneeId) {
      await lockWorkspaceAssignees(tx, workspaceId, [nextAssigneeId]);
    }
    const [existingTask] = await tx
      .select({ task: taskTable, workspaceId: projectTable.workspaceId })
      .from(taskTable)
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .where(eq(taskTable.id, id))
      .for("update")
      .limit(1);
    if (!existingTask) {
      throw new HTTPException(404, { message: "Task not found" });
    }
    oldAssigneeId = existingTask.task.userId;
    if (oldAssigneeId === nextAssigneeId) return existingTask.task;

    if (nextAssigneeId) {
      newAssigneeName = (
        await requireWorkspaceAssignees(tx, existingTask.workspaceId, [
          nextAssigneeId,
        ])
      ).get(nextAssigneeId);
    }
    const [task] = await tx
      .update(taskTable)
      .set({ userId: nextAssigneeId })
      .where(eq(taskTable.id, id))
      .returning();
    return task;
  });

  if (!updatedTask) {
    throw new HTTPException(500, {
      message: "Failed to update task assignee",
    });
  }

  if (!nextAssigneeId) {
    await publishEvent("task.unassigned", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      title: updatedTask.title,
      type: "unassigned",
    });

    return updatedTask;
  }

  await publishEvent("task.assignee_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldAssignee: oldAssigneeId,
    newAssignee: newAssigneeName,
    newAssigneeId: nextAssigneeId,
    title: updatedTask.title,
    type: "assignee_changed",
  });

  return updatedTask;
}

export default updateTaskAssignee;
