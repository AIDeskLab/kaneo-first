import { asc, inArray, or } from "drizzle-orm";
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
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  createdAt: Date;
  sourceProjectId: string;
  targetProjectId: string;
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
 * lock (namespace 1540) via `resolveTaskHierarchy`, then re-reads every
 * resolved task with `SELECT ... FOR UPDATE` in deterministic id order.
 * Snapshots incident relations (including surviving endpoints' project IDs)
 * and asset keys before delete. Callers must publish events and run S3
 * cleanup only after the surrounding transaction commits.
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

  const hierarchyIds = hierarchy.map((task) => task.id);
  const lockIds = [...new Set(hierarchyIds)].sort();

  const taskRows = await tx
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      title: taskTable.title,
    })
    .from(taskTable)
    .where(inArray(taskTable.id, lockIds))
    .orderBy(asc(taskTable.id))
    .for("update");

  if (taskRows.length !== lockIds.length) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const byId = new Map(taskRows.map((task) => [task.id, task]));
  const deletedTasks: DeletedHierarchyTask[] = hierarchyIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new HTTPException(404, { message: "Task not found" });
    }
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
    };
  });

  const relationRows = await tx
    .select({
      id: taskRelationTable.id,
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
      relationType: taskRelationTable.relationType,
      createdAt: taskRelationTable.createdAt,
    })
    .from(taskRelationTable)
    .where(
      or(
        inArray(taskRelationTable.sourceTaskId, lockIds),
        inArray(taskRelationTable.targetTaskId, lockIds),
      ),
    );

  const projectIdByTaskId = new Map(
    taskRows.map((task) => [task.id, task.projectId]),
  );

  const missingEndpointIds = new Set<string>();
  for (const relation of relationRows) {
    if (!projectIdByTaskId.has(relation.sourceTaskId)) {
      missingEndpointIds.add(relation.sourceTaskId);
    }
    if (!projectIdByTaskId.has(relation.targetTaskId)) {
      missingEndpointIds.add(relation.targetTaskId);
    }
  }

  if (missingEndpointIds.size > 0) {
    const endpointRows = await tx
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
      })
      .from(taskTable)
      .where(inArray(taskTable.id, [...missingEndpointIds]));

    for (const row of endpointRows) {
      projectIdByTaskId.set(row.id, row.projectId);
    }
  }

  const deletedRelations: DeletedHierarchyRelation[] = relationRows.map(
    (relation) => {
      const sourceProjectId = projectIdByTaskId.get(relation.sourceTaskId);
      const targetProjectId = projectIdByTaskId.get(relation.targetTaskId);
      if (!sourceProjectId || !targetProjectId) {
        throw new HTTPException(404, { message: "Task not found" });
      }
      return {
        id: relation.id,
        sourceTaskId: relation.sourceTaskId,
        targetTaskId: relation.targetTaskId,
        relationType: relation.relationType,
        createdAt: relation.createdAt,
        sourceProjectId,
        targetProjectId,
      };
    },
  );

  const assets = await tx
    .select({ objectKey: assetTable.objectKey })
    .from(assetTable)
    .where(inArray(assetTable.taskId, lockIds));

  await tx.delete(taskTable).where(inArray(taskTable.id, lockIds));

  return {
    deletedTasks,
    deletedRelations,
    assetKeys: assets.map((asset) => asset.objectKey),
  };
}
