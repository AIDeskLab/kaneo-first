import { inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  assetTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { resolveTaskHierarchy } from "./task-cascade";
import type { DbOrTx } from "./workspace-assignee-lock";

export type DeletedHierarchyTask = {
  id: string;
  projectId: string;
  title: string;
};

export type DeletedHierarchyRelation = {
  sourceTaskId: string;
  targetTaskId: string;
};

export type DeleteTaskHierarchyResult = {
  deletedTasks: DeletedHierarchyTask[];
  deletedRelations: DeletedHierarchyRelation[];
  assetKeys: string[];
};

/**
 * Atomically delete root task(s) and every recursive "subtask" descendant.
 *
 * Must run inside a transaction. Acquires the workspace hierarchy advisory
 * lock (namespace 1540) via `resolveTaskHierarchy`. Callers must publish
 * events and run S3 cleanup only after the surrounding transaction commits.
 */
export async function deleteTaskHierarchy(
  tx: DbOrTx,
  workspaceId: string,
  rootTaskIds: string[],
): Promise<DeleteTaskHierarchyResult> {
  const hierarchy = await resolveTaskHierarchy(tx, workspaceId, rootTaskIds);
  if (hierarchy.length === 0) {
    return { deletedTasks: [], deletedRelations: [], assetKeys: [] };
  }

  const taskIds = hierarchy.map((task) => task.id);

  const taskRows = await tx
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      title: taskTable.title,
    })
    .from(taskTable)
    .where(inArray(taskTable.id, taskIds));

  if (taskRows.length !== taskIds.length) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const byId = new Map(taskRows.map((task) => [task.id, task]));
  const deletedTasks: DeletedHierarchyTask[] = taskIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new HTTPException(404, { message: "Task not found" });
    }
    return row;
  });

  const deletedRelations = await tx
    .select({
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
    })
    .from(taskRelationTable)
    .where(
      or(
        inArray(taskRelationTable.sourceTaskId, taskIds),
        inArray(taskRelationTable.targetTaskId, taskIds),
      ),
    );

  const assets = await tx
    .select({ objectKey: assetTable.objectKey })
    .from(assetTable)
    .where(inArray(assetTable.taskId, taskIds));

  await tx.delete(taskTable).where(inArray(taskTable.id, taskIds));

  return {
    deletedTasks,
    deletedRelations,
    assetKeys: assets.map((asset) => asset.objectKey),
  };
}
