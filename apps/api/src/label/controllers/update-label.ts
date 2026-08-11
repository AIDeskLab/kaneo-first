import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import {
  removeLabelFromGitea,
  syncLabelToGitea,
} from "../../plugins/gitea/utils/sync-label-to-gitea";
import {
  removeLabelFromGitHub,
  syncLabelToGitHub,
} from "../../plugins/github/utils/sync-label-to-github";
import { lockWorkspaceLabels } from "./workspace-label-lock";

type AffectedTaskLabel = {
  label: typeof labelTable.$inferSelect;
  taskId: string;
  projectId: string;
  workspaceId: string;
};

async function loadAffectedTaskLabels(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  labelName: string,
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
        eq(labelTable.name, labelName),
        isNotNull(labelTable.taskId),
      ),
    );
}

async function settleProviderRename(
  affected: AffectedTaskLabel[],
  oldName: string,
  newName: string,
  color: string,
) {
  for (const { taskId } of affected) {
    await removeLabelFromGitHub(taskId, oldName);
    await removeLabelFromGitea(taskId, oldName);
    await syncLabelToGitHub(taskId, newName, color);
    await syncLabelToGitea(taskId, newName, color);
  }
}

async function settleProviderRecolor(
  affected: AffectedTaskLabel[],
  labelName: string,
  color: string,
) {
  for (const { taskId } of affected) {
    await removeLabelFromGitHub(taskId, labelName);
    await removeLabelFromGitea(taskId, labelName);
    await syncLabelToGitHub(taskId, labelName, color);
    await syncLabelToGitea(taskId, labelName, color);
  }
}

async function assertRenameTargetAvailable(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  labelId: string,
  newName: string,
  affected: AffectedTaskLabel[],
) {
  const conflictingDefinition = await tx.query.labelTable.findFirst({
    where: and(
      eq(labelTable.workspaceId, workspaceId),
      eq(labelTable.name, newName),
      isNull(labelTable.taskId),
      ne(labelTable.id, labelId),
    ),
  });
  if (conflictingDefinition) {
    throw new HTTPException(409, {
      message: "A workspace label with this name already exists",
    });
  }

  for (const { taskId, label } of affected) {
    const conflictingTaskLabel = await tx.query.labelTable.findFirst({
      where: and(
        eq(labelTable.taskId, taskId),
        eq(labelTable.name, newName),
        ne(labelTable.id, label.id),
      ),
    });
    if (conflictingTaskLabel) {
      throw new HTTPException(409, {
        message: "A task label with this name already exists",
      });
    }
  }
}

async function updateLabel(id: string, name: string, color: string) {
  const existingLabel = await db.query.labelTable.findFirst({
    where: eq(labelTable.id, id),
  });

  if (!existingLabel) {
    throw new HTTPException(404, {
      message: "Label not found",
    });
  }

  if (existingLabel.taskId) {
    const [task] = await db
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        workspaceId: projectTable.workspaceId,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(eq(taskTable.id, existingLabel.taskId))
      .limit(1);

    if (!task?.workspaceId) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const oldName = existingLabel.name;

    const updatedLabel = await db.transaction(async (tx) => {
      await lockWorkspaceLabels(tx, task.workspaceId, [oldName, name]);
      const current = await tx.query.labelTable.findFirst({
        where: eq(labelTable.id, id),
      });
      if (!current?.taskId) {
        throw new HTTPException(404, { message: "Label not found" });
      }

      if (current.name !== oldName) {
        throw new HTTPException(404, { message: "Label not found" });
      }

      const authoritativeOldName = current.name;
      const renamed = authoritativeOldName !== name;
      const recolored = current.color !== color;

      if (renamed) {
        const conflictingTaskLabel = await tx.query.labelTable.findFirst({
          where: and(
            eq(labelTable.taskId, task.id),
            eq(labelTable.name, name),
            ne(labelTable.id, id),
          ),
        });
        if (conflictingTaskLabel) {
          throw new HTTPException(409, {
            message: "A task label with this name already exists",
          });
        }

        await settleProviderRename(
          [
            {
              label: current,
              taskId: task.id,
              projectId: task.projectId,
              workspaceId: task.workspaceId,
            },
          ],
          authoritativeOldName,
          name,
          color,
        );
      } else if (recolored) {
        await settleProviderRecolor(
          [
            {
              label: current,
              taskId: task.id,
              projectId: task.projectId,
              workspaceId: task.workspaceId,
            },
          ],
          name,
          color,
        );
      }

      const [updated] = await tx
        .update(labelTable)
        .set({ name, color })
        .where(eq(labelTable.id, id))
        .returning();
      if (!updated) {
        throw new HTTPException(404, { message: "Label not found" });
      }
      return updated;
    });

    return updatedLabel;
  }

  if (existingLabel.workspaceId === null) {
    const [updatedLabel] = await db
      .update(labelTable)
      .set({ name, color })
      .where(eq(labelTable.id, id))
      .returning();
    if (!updatedLabel) {
      throw new HTTPException(404, { message: "Label not found" });
    }
    return updatedLabel;
  }

  const workspaceId = existingLabel.workspaceId;
  const oldName = existingLabel.name;
  let affectedLabels: AffectedTaskLabel[] = [];

  const updatedLabel = await db.transaction(async (tx) => {
    await lockWorkspaceLabels(tx, workspaceId, [oldName, name]);
    const current = await tx.query.labelTable.findFirst({
      where: and(
        eq(labelTable.id, id),
        eq(labelTable.workspaceId, workspaceId),
        isNull(labelTable.taskId),
      ),
    });
    if (!current) {
      throw new HTTPException(404, { message: "Label not found" });
    }

    if (current.name !== oldName) {
      throw new HTTPException(404, { message: "Label not found" });
    }

    const authoritativeOldName = current.name;
    const renamed = authoritativeOldName !== name;
    const recolored = current.color !== color;

    affectedLabels = await loadAffectedTaskLabels(
      tx,
      workspaceId,
      authoritativeOldName,
    );

    if (renamed) {
      await assertRenameTargetAvailable(
        tx,
        workspaceId,
        id,
        name,
        affectedLabels,
      );
      await settleProviderRename(
        affectedLabels,
        authoritativeOldName,
        name,
        color,
      );
    } else if (recolored) {
      await settleProviderRecolor(affectedLabels, name, color);
    }

    const [updatedDefinition] = await tx
      .update(labelTable)
      .set({ name, color })
      .where(eq(labelTable.id, id))
      .returning();
    if (!updatedDefinition) {
      throw new HTTPException(404, { message: "Label not found" });
    }

    if (renamed || recolored) {
      await tx
        .update(labelTable)
        .set({ name, color })
        .where(
          and(
            eq(labelTable.workspaceId, workspaceId),
            eq(labelTable.name, authoritativeOldName),
            isNotNull(labelTable.taskId),
          ),
        );
    }

    return updatedDefinition;
  });

  return updatedLabel;
}

export default updateLabel;
