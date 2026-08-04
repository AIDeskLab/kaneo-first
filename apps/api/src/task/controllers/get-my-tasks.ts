import { and, asc, eq, inArray } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  labelTable,
  projectTable,
  taskTable,
} from "../../database/schema";

const STATUSES = [
  "to-do",
  "in-progress",
  "in-review",
  "done",
  "planned",
  "archived",
] as const;
type TaskStatus = (typeof STATUSES)[number];

function isStatus(v: string): v is TaskStatus {
  return (STATUSES as readonly string[]).includes(v);
}

async function getMyTasks(userId: string, status?: string) {
  const conditions = [eq(taskTable.userId, userId)];

  if (status && isStatus(status)) {
    conditions.push(eq(taskTable.status, status));
  }

  const tasks = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      number: taskTable.number,
      status: taskTable.status,
      priority: taskTable.priority,
      dueDate: taskTable.dueDate,
      createdAt: taskTable.createdAt,
      projectId: taskTable.projectId,
      projectSlug: projectTable.slug,
      projectName: projectTable.name,
      columnName: columnTable.name,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(columnTable, eq(taskTable.status, columnTable.slug))
    .where(and(...conditions))
    .orderBy(asc(taskTable.position));

  const taskIds = tasks.map((t) => t.id);

  const labels =
    taskIds.length > 0
      ? await db
          .select({
            id: labelTable.id,
            name: labelTable.name,
            color: labelTable.color,
            taskId: labelTable.taskId,
          })
          .from(labelTable)
          .where(inArray(labelTable.taskId, taskIds))
      : [];

  const labelMap = new Map<
    string,
    { id: string; name: string; color: string }[]
  >();
  for (const l of labels) {
    if (!labelMap.has(l.taskId)) labelMap.set(l.taskId, []);
    labelMap.get(l.taskId)?.push({ id: l.id, name: l.name, color: l.color });
  }

  return {
    tasks: tasks.map((t) => ({
      ...t,
      labels: labelMap.get(t.id) ?? [],
    })),
    total: tasks.length,
  };
}

export default getMyTasks;
