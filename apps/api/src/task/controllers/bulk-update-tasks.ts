import { and, eq, inArray, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  labelTable,
  projectTable,
  taskTable,
  workspaceUserTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { lockWorkspaceLabels } from "../../label/controllers/workspace-label-lock";
import {
  removeLabelFromGitea,
  syncLabelToGitea,
} from "../../plugins/gitea/utils/sync-label-to-gitea";
import {
  removeLabelFromGitHub,
  syncLabelToGitHub,
} from "../../plugins/github/utils/sync-label-to-github";
import { cleanupAssetKeys } from "../../storage/cleanup-assets";
import { validateDateRange } from "../../utils/validate-dates";
import { assertValidPriority } from "../validate-task-fields";
import { deleteTaskHierarchy } from "./delete-task-hierarchy";
import { updateTaskHierarchyStatus } from "./update-task-hierarchy-status";
import {
  lockWorkspaceAssignees,
  requireWorkspaceAssignees,
} from "./workspace-assignee-lock";

type BulkOperation =
  | "updateStatus"
  | "updatePriority"
  | "updateAssignee"
  | "delete"
  | "addLabel"
  | "removeLabel"
  | "updateDueDate";

async function bulkUpdateTasks({
  taskIds,
  operation,
  value,
  userId,
}: {
  taskIds: string[];
  operation: BulkOperation;
  value?: string | null;
  userId: string;
}) {
  const tasks = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      projectId: taskTable.projectId,
      userId: taskTable.userId,
      startDate: taskTable.startDate,
      dueDate: taskTable.dueDate,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, taskIds));

  if (tasks.length === 0) {
    throw new HTTPException(404, {
      message: "No tasks found",
    });
  }

  const workspaceIds = [...new Set(tasks.map((t) => t.workspaceId))];

  if (workspaceIds.length > 1) {
    throw new HTTPException(400, {
      message: "All tasks must belong to the same workspace",
    });
  }

  const workspaceId = workspaceIds[0];

  if (!workspaceId) {
    throw new HTTPException(400, {
      message: "Could not determine workspace",
    });
  }

  const [membership] = await db
    .select({ id: workspaceUserTable.id })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.userId, userId),
        eq(workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new HTTPException(403, {
      message: "You don't have access to this workspace",
    });
  }

  const foundIds = tasks.map((t) => t.id);
  let updatedCount = 0;

  switch (operation) {
    case "updateStatus": {
      if (!value) {
        throw new HTTPException(400, { message: "Status value is required" });
      }

      // Cascades to all recursive "subtask" descendants; overlapping roots
      // are deduped inside updateTaskHierarchyStatus / resolveTaskHierarchy.
      const { changedTasks } = await db.transaction(async (tx) =>
        updateTaskHierarchyStatus(tx, workspaceId, foundIds, value),
      );

      updatedCount = changedTasks.length;

      for (const changed of changedTasks) {
        await publishEvent("task.status_changed", {
          taskId: changed.id,
          projectId: changed.projectId,
          userId,
          oldStatus: changed.oldStatus,
          newStatus: changed.newStatus,
          title: changed.title,
          assigneeId: changed.assigneeId,
          type: "status_changed",
        });
      }

      for (const projectId of [
        ...new Set(changedTasks.map((task) => task.projectId)),
      ]) {
        await publishEvent("task-relation.refresh", {
          projectId,
          userId,
        });
      }
      break;
    }

    case "updatePriority": {
      if (!value) {
        throw new HTTPException(400, { message: "Priority value is required" });
      }
      assertValidPriority(value);

      const result = await db
        .update(taskTable)
        .set({ priority: value })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        await publishEvent("task.priority_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          newPriority: value,
          type: "priority_changed",
        });
      }
      break;
    }

    case "updateAssignee": {
      const nextAssigneeId = value?.trim() || null;
      const firstProjectId = tasks[0]?.projectId;
      if (!firstProjectId) {
        throw new HTTPException(400, {
          message: "Could not determine project",
        });
      }
      let newAssigneeName: string | undefined;
      const result = await db.transaction(async (tx) => {
        if (nextAssigneeId) {
          await lockWorkspaceAssignees(tx, workspaceId, [nextAssigneeId]);
          newAssigneeName = (
            await requireWorkspaceAssignees(tx, workspaceId, [nextAssigneeId])
          ).get(nextAssigneeId);
        }
        return tx
          .update(taskTable)
          .set({ userId: nextAssigneeId })
          .where(inArray(taskTable.id, foundIds));
      });

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        const eventType = nextAssigneeId
          ? "task.assignee_changed"
          : "task.unassigned";
        await publishEvent(eventType, {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          oldAssignee: task.userId,
          newAssignee: newAssigneeName,
          newAssigneeId: nextAssigneeId,
          title: task.title,
          type: nextAssigneeId ? "assignee_changed" : "unassigned",
        });
      }
      break;
    }

    case "delete": {
      const { deletedTasks, deletedRelations, assetKeys } =
        await db.transaction(async (tx) =>
          deleteTaskHierarchy(tx, workspaceId, foundIds),
        );

      updatedCount = deletedTasks.length;

      const projectByTaskId = new Map(
        deletedTasks.map((deleted) => [deleted.id, deleted.projectId]),
      );
      const fallbackProjectId = deletedTasks[0]?.projectId ?? tasks[0]?.projectId;

      for (const deleted of deletedTasks) {
        await publishEvent("task.deleted", {
          taskId: deleted.id,
          projectId: deleted.projectId,
          userId,
          title: deleted.title,
        });
      }

      for (const relation of deletedRelations) {
        const projectId =
          projectByTaskId.get(relation.sourceTaskId) ??
          projectByTaskId.get(relation.targetTaskId) ??
          fallbackProjectId;

        if (!projectId) continue;

        await publishEvent("task-relation.deleted", {
          projectId,
          userId,
          taskId: projectByTaskId.has(relation.sourceTaskId)
            ? relation.sourceTaskId
            : relation.targetTaskId,
          sourceTaskId: relation.sourceTaskId,
          targetTaskId: relation.targetTaskId,
        });
      }

      cleanupAssetKeys(assetKeys).catch(() => {});
      break;
    }

    case "addLabel": {
      if (!value) {
        throw new HTTPException(400, { message: "Label ID is required" });
      }

      const assignedTaskIds = await db.transaction(async (tx) => {
        const preRead = await tx.query.labelTable.findFirst({
          where: eq(labelTable.id, value),
        });
        if (!preRead?.workspaceId || preRead.workspaceId !== workspaceId) {
          throw new HTTPException(404, { message: "Label not found" });
        }
        if (preRead.taskId) {
          throw new HTTPException(400, {
            message: "Workspace label definition is required",
          });
        }

        await lockWorkspaceLabels(tx, workspaceId, [preRead.name]);
        const definition = await tx.query.labelTable.findFirst({
          where: and(
            eq(labelTable.id, value),
            eq(labelTable.workspaceId, workspaceId),
            isNull(labelTable.taskId),
          ),
        });
        if (!definition) {
          throw new HTTPException(404, { message: "Label not found" });
        }

        const added: string[] = [];
        for (const task of tasks) {
          const existingAssignment = await tx.query.labelTable.findFirst({
            where: and(
              eq(labelTable.name, definition.name),
              eq(labelTable.taskId, task.id),
            ),
          });
          if (existingAssignment) continue;
          await syncLabelToGitHub(task.id, definition.name, definition.color);
          await syncLabelToGitea(task.id, definition.name, definition.color);
          const inserted = await tx
            .insert(labelTable)
            .values({
              name: definition.name,
              color: definition.color,
              workspaceId: workspaceId,
              taskId: task.id,
            })
            .onConflictDoNothing({
              target: [labelTable.taskId, labelTable.name],
            })
            .returning({ id: labelTable.id });
          if (inserted.length > 0) added.push(task.id);
        }
        return added;
      });
      updatedCount = assignedTaskIds.length;
      for (const task of tasks) {
        if (assignedTaskIds.includes(task.id)) {
          await publishEvent("task.label_assigned", {
            projectId: task.projectId,
            taskId: task.id,
            userId,
            type: "label_assigned",
          });
        }
      }
      break;
    }

    case "removeLabel": {
      if (!value) {
        throw new HTTPException(400, { message: "Label ID is required" });
      }

      const label = await db.query.labelTable.findFirst({
        where: eq(labelTable.id, value),
      });

      if (!label) {
        throw new HTTPException(404, { message: "Label not found" });
      }

      const deletedLabels = await db.transaction(async (tx) => {
        await lockWorkspaceLabels(tx, workspaceId, [label.name]);
        const affectedLabels = await tx.query.labelTable.findMany({
          where: and(
            eq(labelTable.workspaceId, workspaceId),
            eq(labelTable.name, label.name),
            inArray(labelTable.taskId, foundIds),
          ),
        });
        for (const affectedLabel of affectedLabels) {
          if (!affectedLabel.taskId) continue;
          await removeLabelFromGitHub(affectedLabel.taskId, affectedLabel.name);
          await removeLabelFromGitea(affectedLabel.taskId, affectedLabel.name);
        }
        return tx
          .delete(labelTable)
          .where(
            and(
              eq(labelTable.workspaceId, workspaceId),
              eq(labelTable.name, label.name),
              inArray(labelTable.taskId, foundIds),
            ),
          )
          .returning();
      });

      updatedCount = deletedLabels.length;

      for (const deletedLabel of deletedLabels) {
        if (!deletedLabel.taskId) continue;

        const task = tasks.find((t) => t.id === deletedLabel.taskId);
        if (!task) continue;

        await publishEvent("task.label_unassigned", {
          label: deletedLabel,
          task,
          projectId: task.projectId,
          taskId: deletedLabel.taskId,
          userId,
          type: "label_unassigned",
        });
      }
      break;
    }

    case "updateDueDate": {
      let parsedDate: Date | null = null;
      if (value) {
        parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new HTTPException(400, {
            message: `Invalid date value "${value}"`,
          });
        }
      }

      for (const task of tasks) {
        validateDateRange(task.startDate ?? undefined, parsedDate ?? undefined);
      }

      const result = await db
        .update(taskTable)
        .set({ dueDate: parsedDate })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        await publishEvent("task.due_date_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          oldDueDate: task.dueDate,
          newDueDate: parsedDate,
          title: task.title,
          type: "due_date_changed",
        });
      }
      break;
    }

    default: {
      throw new HTTPException(400, {
        message: `Unknown operation "${operation}"`,
      });
    }
  }

  return { success: true, updatedCount };
}

export default bulkUpdateTasks;
