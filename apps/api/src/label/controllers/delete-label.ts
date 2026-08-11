import { and, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { removeLabelFromGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { removeLabelFromGitHub } from "../../plugins/github/utils/sync-label-to-github";
import { lockWorkspaceLabels } from "./workspace-label-lock";

async function deleteLabel(id: string, userId: string) {
  const label = await db.query.labelTable.findFirst({
    where: (label, { eq }) => eq(label.id, id),
  });

  if (!label) {
    throw new HTTPException(404, {
      message: "Label not found",
    });
  }
  const existingLabel = label;

  if (existingLabel.taskId) {
    const taskId = existingLabel.taskId;
    // Task-level label: fetch task, delete with event + GitHub sync
    const [task] = await db
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        workspaceId: projectTable.workspaceId,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(eq(taskTable.id, taskId))
      .limit(1);

    if (!task) {
      throw new HTTPException(404, {
        message: "Task not found",
      });
    }

    const deletedLabel = await db.transaction(async (tx) => {
      await lockWorkspaceLabels(tx, task.workspaceId, [existingLabel.name]);
      await removeLabelFromGitHub(taskId, existingLabel.name);
      await removeLabelFromGitea(taskId, existingLabel.name);
      const [deleted] = await tx
        .delete(labelTable)
        .where(eq(labelTable.id, id))
        .returning();
      return deleted;
    });

    if (!deletedLabel) {
      throw new HTTPException(404, {
        message: "Label not found",
      });
    }

    await publishEvent("task.label_deleted", {
      label: deletedLabel,
      task,
      projectId: task.projectId,
      taskId: task.id,
      userId,
      type: "label_deleted",
    });

    return deletedLabel;
  }

  // Label without a workspace: the cascade filter below could never match
  if (existingLabel.workspaceId === null) {
    const [deletedLabel] = await db
      .delete(labelTable)
      .where(eq(labelTable.id, id))
      .returning();
    if (!deletedLabel) {
      throw new HTTPException(404, { message: "Label not found" });
    }
    return deletedLabel;
  }
  const workspaceId = existingLabel.workspaceId;

  // Capture affected task-level labels before cascading so we have data
  // for events and provider sync
  let affectedLabels: Awaited<ReturnType<typeof loadAffectedLabels>> = [];
  async function loadAffectedLabels(
    tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  ) {
    return tx
      .select({
        label: labelTable,
        taskId: taskTable.id,
        projectId: projectTable.id,
        workspaceId: projectTable.workspaceId,
      })
      .from(labelTable)
      .innerJoin(taskTable, eq(labelTable.taskId, taskTable.id))
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(
        and(
          eq(labelTable.workspaceId, workspaceId),
          eq(labelTable.name, existingLabel.name),
          isNotNull(labelTable.taskId),
        ),
      );
  }

  // Remote-first is retry-safe: provider helpers treat missing integrations and
  // already-absent labels as success, while any real provider failure leaves all
  // local rows intact for a later retry.
  const deletedLabel = await db.transaction(async (tx) => {
    await lockWorkspaceLabels(tx, workspaceId, [existingLabel.name]);
    affectedLabels = await loadAffectedLabels(tx);
    for (const { label: affectedLabel } of affectedLabels) {
      if (!affectedLabel.taskId) continue;
      await removeLabelFromGitHub(affectedLabel.taskId, affectedLabel.name);
      await removeLabelFromGitea(affectedLabel.taskId, affectedLabel.name);
    }
    const [deletedDefinition] = await tx
      .delete(labelTable)
      .where(eq(labelTable.id, id))
      .returning();
    if (!deletedDefinition) {
      throw new HTTPException(404, { message: "Label not found" });
    }
    await tx
      .delete(labelTable)
      .where(
        and(
          eq(labelTable.workspaceId, workspaceId),
          eq(labelTable.name, existingLabel.name),
          isNotNull(labelTable.taskId),
        ),
      );
    return deletedDefinition;
  });

  // Emit events and sync providers for each affected task
  for (const { label: l, taskId, projectId } of affectedLabels) {
    await publishEvent("task.label_deleted", {
      label: l,
      task: { id: taskId, projectId },
      projectId,
      taskId,
      userId,
      type: "label_deleted",
    });
  }

  return deletedLabel;
}

export default deleteLabel;
