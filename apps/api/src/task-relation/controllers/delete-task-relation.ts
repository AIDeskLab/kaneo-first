import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { lockWorkspaceTaskHierarchy } from "../../task/controllers/task-cascade";

async function deleteTaskRelation(id: string, userId: string) {
  const { relation, sourceProjectId, targetProjectId } = await db.transaction(
    async (tx) => {
      // Non-authoritative: only discovers the advisory-lock key for the source
      // endpoint's workspace. All relation/endpoint data is re-read after lock.
      const [discovered] = await tx
        .select({
          workspaceId: projectTable.workspaceId,
        })
        .from(taskRelationTable)
        .innerJoin(taskTable, eq(taskRelationTable.sourceTaskId, taskTable.id))
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(eq(taskRelationTable.id, id))
        .limit(1);

      if (!discovered) {
        throw new HTTPException(404, {
          message: "Task relation not found",
        });
      }

      const discoveredWorkspaceId = discovered.workspaceId;

      await lockWorkspaceTaskHierarchy(tx, discoveredWorkspaceId);

      const [lockedRelation] = await tx
        .select({
          id: taskRelationTable.id,
          sourceTaskId: taskRelationTable.sourceTaskId,
          targetTaskId: taskRelationTable.targetTaskId,
        })
        .from(taskRelationTable)
        .where(eq(taskRelationTable.id, id))
        .limit(1);

      if (!lockedRelation) {
        throw new HTTPException(404, {
          message: "Task relation not found",
        });
      }

      const [sourceTask] = await tx
        .select({
          id: taskTable.id,
          projectId: taskTable.projectId,
          workspaceId: projectTable.workspaceId,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(
          and(
            eq(taskTable.id, lockedRelation.sourceTaskId),
            eq(projectTable.workspaceId, discoveredWorkspaceId),
          ),
        )
        .limit(1);

      const [targetTask] = await tx
        .select({
          id: taskTable.id,
          projectId: taskTable.projectId,
          workspaceId: projectTable.workspaceId,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(
          and(
            eq(taskTable.id, lockedRelation.targetTaskId),
            eq(projectTable.workspaceId, discoveredWorkspaceId),
          ),
        )
        .limit(1);

      if (!sourceTask || !targetTask) {
        throw new HTTPException(404, {
          message: "Task relation not found",
        });
      }

      const [deleted] = await tx
        .delete(taskRelationTable)
        .where(eq(taskRelationTable.id, id))
        .returning();

      if (!deleted) {
        throw new HTTPException(404, {
          message: "Task relation not found",
        });
      }

      return {
        relation: deleted,
        sourceProjectId: sourceTask.projectId,
        targetProjectId: targetTask.projectId,
      };
    },
  );

  // Source-then-target ordering with Set deduplication when projects match.
  const projectIds = [...new Set([sourceProjectId, targetProjectId])];
  for (const projectId of projectIds) {
    await publishEvent("task-relation.deleted", {
      ...relation,
      taskId: relation.sourceTaskId,
      projectId,
      userId,
    });
  }

  return relation;
}

export default deleteTaskRelation;
