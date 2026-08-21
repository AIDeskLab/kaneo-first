import { eq } from "drizzle-orm";
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
  const result = await db.transaction(async (tx) => {
    const [rel] = await tx
      .select({
        sourceTaskId: taskRelationTable.sourceTaskId,
        targetTaskId: taskRelationTable.targetTaskId,
      })
      .from(taskRelationTable)
      .where(eq(taskRelationTable.id, id))
      .limit(1);

    if (!rel) {
      throw new HTTPException(404, {
        message: "Task relation not found",
      });
    }

    const [task] = await tx
      .select({
        projectId: taskTable.projectId,
        workspaceId: projectTable.workspaceId,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(eq(taskTable.id, rel.sourceTaskId))
      .limit(1);

    if (!task) {
      throw new HTTPException(404, {
        message: "Task relation not found",
      });
    }

    await lockWorkspaceTaskHierarchy(tx, task.workspaceId);

    const [relation] = await tx
      .delete(taskRelationTable)
      .where(eq(taskRelationTable.id, id))
      .returning();

    if (!relation) {
      throw new HTTPException(404, {
        message: "Task relation not found",
      });
    }

    return {
      relation,
      sourceTaskId: rel.sourceTaskId,
      targetTaskId: rel.targetTaskId,
      projectId: task.projectId,
    };
  });

  await publishEvent("task-relation.deleted", {
    ...result.relation,
    taskId: result.sourceTaskId,
    sourceTaskId: result.sourceTaskId,
    targetTaskId: result.targetTaskId,
    projectId: result.projectId,
    userId,
  });

  return result.relation;
}

export default deleteTaskRelation;
