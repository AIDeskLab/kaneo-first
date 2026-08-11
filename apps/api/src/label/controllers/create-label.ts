import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { syncLabelToGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { syncLabelToGitHub } from "../../plugins/github/utils/sync-label-to-github";
import { lockWorkspaceLabels } from "./workspace-label-lock";

async function createLabel(
  name: string,
  color: string,
  taskId: string | undefined,
  workspaceId: string,
  userId: string,
) {
  if (taskId) {
    const result = await db.transaction(async (tx) => {
      const [task] = await tx
        .select({
          id: taskTable.id,
          projectId: taskTable.projectId,
          workspaceId: projectTable.workspaceId,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(eq(taskTable.id, taskId))
        .limit(1);

      if (!task || task.workspaceId !== workspaceId) {
        throw new HTTPException(404, { message: "Task not found" });
      }

      await lockWorkspaceLabels(tx, task.workspaceId, [name]);
      const existing = await tx.query.labelTable.findFirst({
        where: and(eq(labelTable.taskId, taskId), eq(labelTable.name, name)),
      });
      if (existing) return { label: existing, inserted: false, task };

      await syncLabelToGitHub(taskId, name, color);
      await syncLabelToGitea(taskId, name, color);

      const [inserted] = await tx
        .insert(labelTable)
        .values({ name, color, taskId, workspaceId: task.workspaceId })
        .onConflictDoNothing({ target: [labelTable.taskId, labelTable.name] })
        .returning();
      const label =
        inserted ??
        (await tx.query.labelTable.findFirst({
          where: and(eq(labelTable.taskId, taskId), eq(labelTable.name, name)),
        }));
      return { label, inserted: Boolean(inserted), task };
    });

    const { label, inserted, task } = result;

    if (!label) {
      throw new Error("Failed to create or resolve label");
    }

    if (inserted) {
      await publishEvent("task.label_created", {
        projectId: task.projectId,
        taskId: task.id,
        userId: userId,
        type: "label_created",
      });
    }
    return label;
  }

  const label = await db.transaction(async (tx) => {
    await lockWorkspaceLabels(tx, workspaceId, [name]);
    const [inserted] = await tx
      .insert(labelTable)
      .values({ name, color, taskId: null, workspaceId })
      .onConflictDoNothing({
        target: [labelTable.workspaceId, labelTable.name],
        where: sql`${labelTable.taskId} is null`,
      })
      .returning();

    return (
      inserted ??
      (await tx.query.labelTable.findFirst({
        where: and(
          eq(labelTable.workspaceId, workspaceId),
          eq(labelTable.name, name),
          isNull(labelTable.taskId),
        ),
      }))
    );
  });

  if (!label) {
    throw new Error("Failed to create or resolve label");
  }

  return label;
}

export default createLabel;
