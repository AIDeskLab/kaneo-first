import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { columnTable, taskTable } from "../../database/schema";
import { VIRTUAL_STATUSES } from "../validate-task-fields";
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
  /**
   * Every project that received a status/column write, sorted
   * deterministically (for post-commit `task-relation.refresh`).
   */
  refreshProjectIds: string[];
  /**
   * Legacy singular field: first entry of `refreshProjectIds`, or null when
   * the update was empty/idempotent. Prefer `refreshProjectIds`.
   */
  refreshProjectId: string | null;
};

/**
 * Atomically set status on root task(s) and every recursive "subtask" descendant.
 *
 * Must run inside a transaction. Acquires the workspace hierarchy advisory
 * lock (namespace 1540) via `resolveTaskHierarchy`, then re-reads every
 * resolved task with `SELECT ... FOR UPDATE` in deterministic id order.
 * Validates the target status against every affected project through `tx`
 * before any write — virtual statuses ("planned", "archived") always use
 * `columnId=null`; other statuses resolve a project-specific column. Any
 * validation error aborts with no writes.
 *
 * Callers must publish `task.status_changed` only for `changedTasks` and
 * `task-relation.refresh` for `refreshProjectIds` (or the legacy singular
 * `refreshProjectId`) after the surrounding transaction commits.
 * Priority/assignee/dates/labels/move are intentionally out of scope.
 */
export async function updateTaskHierarchyStatus(
  tx: DbOrTx,
  workspaceId: string,
  rootTaskIds: string[],
  status: string,
): Promise<UpdateTaskHierarchyStatusResult> {
  const hierarchy = await resolveTaskHierarchy(tx, workspaceId, rootTaskIds);
  if (hierarchy.length === 0) {
    return { changedTasks: [], refreshProjectIds: [], refreshProjectId: null };
  }

  const taskIds = [...new Set(hierarchy.map((task) => task.id))].sort();

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
    .where(inArray(taskTable.id, taskIds))
    .orderBy(asc(taskTable.id))
    .for("update");

  if (taskRows.length !== taskIds.length) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const byId = new Map(taskRows.map((task) => [task.id, task]));
  const projectIds = [
    ...new Set(taskRows.map((task) => task.projectId)),
  ].sort();

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

  const refreshProjectIds = [...updateIdsByProject.keys()].sort();

  for (const projectId of refreshProjectIds) {
    const ids = updateIdsByProject.get(projectId);
    if (!ids) {
      continue;
    }

    const columnId = columnIdByProject.get(projectId) ?? null;
    await tx
      .update(taskTable)
      .set({ status, columnId })
      .where(inArray(taskTable.id, ids));
  }

  return {
    changedTasks,
    refreshProjectIds,
    refreshProjectId: refreshProjectIds[0] ?? null,
  };
}
