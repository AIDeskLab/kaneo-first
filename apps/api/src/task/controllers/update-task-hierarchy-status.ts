import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { columnTable, taskTable } from "../../database/schema";
import {
  assertValidTaskStatus,
  VIRTUAL_STATUSES,
} from "../validate-task-fields";
import { resolveTaskHierarchy } from "./task-cascade";
import type { DbOrTx } from "./workspace-assignee-lock";

export type StatusChangedHierarchyTask = {
  id: string;
  projectId: string;
  title: string;
  oldStatus: string;
  newStatus: string;
  assigneeId: string | null;
};

export type UpdateTaskHierarchyStatusResult = {
  /** Tasks whose status value actually changed (for post-commit events). */
  changedTasks: StatusChangedHierarchyTask[];
  /** Single project id for one `task-relation.refresh` after commit. */
  refreshProjectId: string | null;
};

/**
 * Atomically set status on root task(s) and every recursive "subtask" descendant.
 *
 * Must run inside a transaction. Acquires the workspace hierarchy advisory
 * lock (namespace 1540) via `resolveTaskHierarchy`. Validates the target
 * status against every affected project before any write — virtual statuses
 * ("planned", "archived") always use `columnId=null`; other statuses resolve
 * a project-specific column. Any validation error aborts with no writes.
 *
 * Callers must publish `task.status_changed` only for `changedTasks` and one
 * `task-relation.refresh` (when `refreshProjectId` is set) after the
 * surrounding transaction commits. Priority/assignee/dates/labels/move are
 * intentionally out of scope.
 */
export async function updateTaskHierarchyStatus(
  tx: DbOrTx,
  workspaceId: string,
  rootTaskIds: string[],
  status: string,
): Promise<UpdateTaskHierarchyStatusResult> {
  const hierarchy = await resolveTaskHierarchy(tx, workspaceId, rootTaskIds);
  if (hierarchy.length === 0) {
    return { changedTasks: [], refreshProjectId: null };
  }

  const taskIds = hierarchy.map((task) => task.id);
  const projectIds = [...new Set(hierarchy.map((task) => task.projectId))];

  // Preflight: validate across all affected projects before any write.
  for (const projectId of projectIds) {
    await assertValidTaskStatus(status, projectId);
  }

  const isVirtual = (VIRTUAL_STATUSES as readonly string[]).includes(status);
  const columnIdByProject = new Map<string, string | null>();

  for (const projectId of projectIds) {
    if (isVirtual) {
      columnIdByProject.set(projectId, null);
      continue;
    }

    const [column] = await tx
      .select({ id: columnTable.id })
      .from(columnTable)
      .where(
        and(eq(columnTable.projectId, projectId), eq(columnTable.slug, status)),
      )
      .limit(1);

    if (!column) {
      throw new HTTPException(400, {
        message: `Invalid status "${status}" for project`,
      });
    }

    columnIdByProject.set(projectId, column.id);
  }

  const taskRows = await tx
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      title: taskTable.title,
      status: taskTable.status,
      columnId: taskTable.columnId,
      userId: taskTable.userId,
    })
    .from(taskTable)
    .where(inArray(taskTable.id, taskIds));

  if (taskRows.length !== taskIds.length) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const byId = new Map(taskRows.map((task) => [task.id, task]));
  const changedTasks: StatusChangedHierarchyTask[] = [];
  const updateIdsByProject = new Map<string, string[]>();

  for (const id of taskIds) {
    const row = byId.get(id);
    if (!row) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const nextColumnId = columnIdByProject.get(row.projectId) ?? null;
    if (row.status === status && row.columnId === nextColumnId) {
      continue;
    }

    const projectUpdates = updateIdsByProject.get(row.projectId) ?? [];
    projectUpdates.push(row.id);
    updateIdsByProject.set(row.projectId, projectUpdates);

    if (row.status !== status) {
      changedTasks.push({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        oldStatus: row.status,
        newStatus: status,
        assigneeId: row.userId,
      });
    }
  }

  for (const [projectId, ids] of updateIdsByProject) {
    const columnId = columnIdByProject.get(projectId) ?? null;
    await tx
      .update(taskTable)
      .set({ status, columnId })
      .where(inArray(taskTable.id, ids));
  }

  const rootProjectId = hierarchy[0]?.projectId ?? null;

  return {
    changedTasks,
    refreshProjectId: updateIdsByProject.size > 0 ? rootProjectId : null,
  };
}
