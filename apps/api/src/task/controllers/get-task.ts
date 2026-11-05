import { boundedTaskRead } from "../bounded-read";
import { alias } from "drizzle-orm/pg-core";
import { boardDescription, descriptionDeferred } from "../description-pages";
import { getSubtaskCounts } from "../get-subtask-counts";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  taskTable,
  userTable,
  projectTable,
  taskRelationTable,
} from "../../database/schema";

type LoadedTask = {
  id: string;
  title: string;
  number: number | null;
  description: string | null;
  descriptionDeferred?: boolean;
  status: string;
  columnId: string | null;
  priority: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  recurrence: {
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
    weekdays?: number[];
    timeZone: string;
  } | null;
  position: number | null;
  createdAt: Date;
  userId: string | null;
  assigneeName: string | null;
  assigneeId: string | null;
  projectId: string;
  workspaceId: string | null;
  subtaskCounts: { completed: number; total: number };
  parentSubtaskCounts: {
    taskId: string;
    completed: number;
    total: number;
  }[];
};

async function getTask(
  taskId: string,
  board = false,
  userId?: string,
): Promise<LoadedTask> {
  const task = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      number: taskTable.number,
      description: board ? boardDescription : taskTable.description,
      ...(board
        ? {
            descriptionDeferred,
          }
        : {}),
      status: taskTable.status,
      columnId: taskTable.columnId,
      priority: taskTable.priority,
      startDate: taskTable.startDate,
      dueDate: taskTable.dueDate,
      recurrence: taskTable.recurrence,
      position: taskTable.position,
      createdAt: taskTable.createdAt,
      userId: taskTable.userId,
      assigneeName: userTable.name,
      assigneeId: userTable.id,
      projectId: taskTable.projectId,
      workspaceId: sql<string>`(select ${projectTable.workspaceId} from ${projectTable} where ${projectTable.id} = ${taskTable.projectId})`,
    })
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);

  if (!task.length || !task[0]) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const emptyCounts = { completed: 0, total: 0 };
  if (!board) {
    return {
      ...task[0],
      workspaceId: task[0].workspaceId ?? null,
      subtaskCounts: emptyCounts,
      parentSubtaskCounts: [],
    } as LoadedTask;
  }
  const { workspaceId, ...result } = task[0];
  if (!workspaceId) {
    return {
      ...result,
      workspaceId: null,
      subtaskCounts: emptyCounts,
      parentSubtaskCounts: [],
    } as LoadedTask;
  }
  const parent = alias(taskTable, "parent");
  const parents = await db
    .selectDistinct({ id: parent.id })
    .from(taskRelationTable)
    .innerJoin(parent, eq(taskRelationTable.sourceTaskId, parent.id))
    .where(
      and(
        eq(taskRelationTable.targetTaskId, taskId),
        eq(taskRelationTable.relationType, "subtask"),
        eq(parent.projectId, result.projectId),
      ),
    );
  const counts = await boundedTaskRead((tx) =>
    getSubtaskCounts(
      tx,
      [taskId, ...parents.map((task) => task.id)],
      workspaceId,
      false,
      userId,
    ),
  );
  return {
    ...result,
    subtaskCounts: counts.get(taskId) ?? emptyCounts,
    parentSubtaskCounts: parents.map(({ id }) => ({
      taskId: id,
      ...(counts.get(id) ?? emptyCounts),
    })),
  } as LoadedTask;
}

export default getTask;
