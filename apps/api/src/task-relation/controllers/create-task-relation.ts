import { and, eq, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import {
  lockWorkspaceTaskHierarchy,
  resolveTaskHierarchy,
} from "../../task/controllers/task-cascade";

async function createTaskRelation({
  sourceTaskId,
  targetTaskId,
  relationType,
  userId,
  workspaceId,
}: {
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  userId: string;
  workspaceId: string;
}) {
  if (sourceTaskId === targetTaskId) {
    throw new HTTPException(400, {
      message: "Cannot create a relation between a task and itself",
    });
  }

  const { relation, sourceProjectId, targetProjectId } = await db.transaction(
    async (tx) => {
      await lockWorkspaceTaskHierarchy(tx, workspaceId);

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
            eq(taskTable.id, sourceTaskId),
            eq(projectTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!sourceTask) {
        throw new HTTPException(404, { message: "Source task not found" });
      }

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
            eq(taskTable.id, targetTaskId),
            eq(projectTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (!targetTask) {
        throw new HTTPException(404, { message: "Target task not found" });
      }

      const existing = await tx
        .select({ id: taskRelationTable.id })
        .from(taskRelationTable)
        .where(
          and(
            eq(taskRelationTable.relationType, relationType),
            or(
              and(
                eq(taskRelationTable.sourceTaskId, sourceTaskId),
                eq(taskRelationTable.targetTaskId, targetTaskId),
              ),
              and(
                eq(taskRelationTable.sourceTaskId, targetTaskId),
                eq(taskRelationTable.targetTaskId, sourceTaskId),
              ),
            ),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        throw new HTTPException(409, {
          message: "This relation already exists",
        });
      }

      if (relationType === "subtask") {
        // Edge is parent(source) → child(target). A cycle exists if the parent
        // is already reachable from the child through existing subtask edges.
        const reachableFromTarget = await resolveTaskHierarchy(
          tx,
          workspaceId,
          [targetTaskId],
        );
        if (reachableFromTarget.some((task) => task.id === sourceTaskId)) {
          throw new HTTPException(400, {
            message:
              "Cannot create relation: would create a cycle in the task hierarchy",
          });
        }
      }

      const [created] = await tx
        .insert(taskRelationTable)
        .values({
          sourceTaskId,
          targetTaskId,
          relationType,
        })
        .returning();

      if (!created) {
        throw new HTTPException(500, {
          message: "Failed to create task relation",
        });
      }

      return {
        relation: created,
        sourceProjectId: sourceTask.projectId,
        targetProjectId: targetTask.projectId,
      };
    },
  );

  // Source-then-target ordering with Set deduplication when projects match.
  const projectIds = [...new Set([sourceProjectId, targetProjectId])];
  for (const projectId of projectIds) {
    await publishEvent("task-relation.created", {
      ...relation,
      taskId: sourceTaskId,
      projectId,
      userId,
    });
  }

  return relation;
}

export default createTaskRelation;
