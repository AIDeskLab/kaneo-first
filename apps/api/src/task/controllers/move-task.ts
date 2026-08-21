import { and, asc, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  assetTable,
  columnTable,
  projectTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { claimTaskNumber } from "./claim-task-numbers";
import { lockWorkspaceTaskHierarchy } from "./task-cascade";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function isSameProjectMove(
  sourceProjectId: string,
  destinationProjectId: string,
) {
  return sourceProjectId === destinationProjectId;
}

async function resolveDestinationStatus(
  dbOrTx: DbOrTx,
  destinationProjectId: string,
  currentStatus: string,
  requestedStatus?: string,
) {
  const destinationColumns = await dbOrTx
    .select({
      id: columnTable.id,
      slug: columnTable.slug,
      position: columnTable.position,
    })
    .from(columnTable)
    .where(eq(columnTable.projectId, destinationProjectId))
    .orderBy(asc(columnTable.position));

  const [firstColumn] = destinationColumns;

  if (!firstColumn) {
    throw new HTTPException(400, {
      message: "Destination project does not have a workflow",
    });
  }

  const requestedColumn = requestedStatus
    ? destinationColumns.find((column) => column.slug === requestedStatus)
    : null;

  if (requestedStatus && !requestedColumn) {
    throw new HTTPException(400, {
      message: "Selected status is not valid for the destination project",
    });
  }

  const matchingCurrentColumn = destinationColumns.find(
    (column) => column.slug === currentStatus,
  );

  return requestedColumn ?? matchingCurrentColumn ?? firstColumn;
}

async function getNextTaskPosition(
  dbOrTx: DbOrTx,
  projectId: string,
  status: string,
  columnId: string,
) {
  const [maxPositionResult] = await dbOrTx
    .select({ maxPosition: max(taskTable.position) })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        eq(taskTable.status, status),
        eq(taskTable.columnId, columnId),
      ),
    );

  return (maxPositionResult?.maxPosition ?? 0) + 1;
}

async function moveTask({
  taskId,
  destinationProjectId,
  destinationStatus,
  currentUserId,
}: {
  taskId: string;
  destinationProjectId: string;
  destinationStatus?: string;
  currentUserId: string;
}) {
  const existingTask = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  if (isSameProjectMove(existingTask.projectId, destinationProjectId)) {
    throw new HTTPException(400, {
      message: "Task is already in that project",
    });
  }

  const [sourceProject, destinationProject] = await Promise.all([
    db.query.projectTable.findFirst({
      where: eq(projectTable.id, existingTask.projectId),
    }),
    db.query.projectTable.findFirst({
      where: eq(projectTable.id, destinationProjectId),
    }),
  ]);

  if (!sourceProject || !destinationProject) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  if (sourceProject.workspaceId !== destinationProject.workspaceId) {
    throw new HTTPException(400, {
      message: "Tasks can only be moved within the same workspace",
    });
  }

  const {
    movedTask,
    sourceProjectSnapshot,
    destinationProjectSnapshot,
    oldStatus,
    newStatus,
  } = await db.transaction(async (tx) => {
    await lockWorkspaceTaskHierarchy(tx, sourceProject.workspaceId);

    const [lockedTask] = await tx
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        status: taskTable.status,
      })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update")
      .limit(1);

    if (!lockedTask) {
      throw new HTTPException(404, {
        message: "Task not found",
      });
    }

    const [lockedSourceProject] = await tx
      .select({
        id: projectTable.id,
        name: projectTable.name,
        workspaceId: projectTable.workspaceId,
      })
      .from(projectTable)
      .where(eq(projectTable.id, existingTask.projectId))
      .for("update")
      .limit(1);

    if (!lockedSourceProject) {
      throw new HTTPException(404, {
        message: "Project not found",
      });
    }

    if (lockedTask.projectId !== existingTask.projectId) {
      throw new HTTPException(409, {
        message: "Task project changed while the task was being moved",
      });
    }

    if (lockedSourceProject.workspaceId !== sourceProject.workspaceId) {
      throw new HTTPException(409, {
        message: "Task workspace changed while the task was being moved",
      });
    }

    const [lockedDestinationProject] = await tx
      .select({
        id: projectTable.id,
        name: projectTable.name,
        workspaceId: projectTable.workspaceId,
      })
      .from(projectTable)
      .where(eq(projectTable.id, destinationProjectId))
      .for("update")
      .limit(1);

    if (!lockedDestinationProject) {
      throw new HTTPException(404, {
        message: "Project not found",
      });
    }

    if (lockedDestinationProject.workspaceId !== sourceProject.workspaceId) {
      throw new HTTPException(409, {
        message:
          "Destination project workspace changed while the task was being moved",
      });
    }

    const resolvedColumn = await resolveDestinationStatus(
      tx,
      destinationProjectId,
      lockedTask.status,
      destinationStatus,
    );

    const [nextTaskNumber, nextPosition] = await Promise.all([
      claimTaskNumber(destinationProjectId, tx),
      getNextTaskPosition(
        tx,
        destinationProjectId,
        resolvedColumn.slug,
        resolvedColumn.id,
      ),
    ]);

    const [updatedTask] = await tx
      .update(taskTable)
      .set({
        projectId: destinationProjectId,
        status: resolvedColumn.slug,
        columnId: resolvedColumn.id,
        number: nextTaskNumber,
        position: nextPosition,
      })
      .where(eq(taskTable.id, taskId))
      .returning();

    if (!updatedTask) {
      throw new HTTPException(500, {
        message: "Failed to move task",
      });
    }

    await tx
      .update(assetTable)
      .set({ projectId: destinationProjectId })
      .where(eq(assetTable.taskId, taskId));

    return {
      movedTask: updatedTask,
      sourceProjectSnapshot: lockedSourceProject,
      destinationProjectSnapshot: lockedDestinationProject,
      oldStatus: lockedTask.status,
      newStatus: resolvedColumn.slug,
    };
  });

  await publishEvent("task.moved", {
    taskId,
    type: "moved",
    userId: currentUserId,
    fromProjectId: sourceProjectSnapshot.id,
    fromProjectName: sourceProjectSnapshot.name,
    toProjectId: destinationProjectSnapshot.id,
    toProjectName: destinationProjectSnapshot.name,
    oldStatus,
    newStatus,
  });

  return {
    task: movedTask,
    sourceProjectId: sourceProjectSnapshot.id,
    destinationProjectId: destinationProjectSnapshot.id,
  };
}

export default moveTask;
