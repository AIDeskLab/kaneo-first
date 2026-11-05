import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  externalLinkTable,
  labelTable,
  projectTable,
  taskRelationTable,
  taskTable,
  userTable,
} from "../../database/schema";
import {
  boardDescription,
  boardProjectDescription,
  descriptionDeferred,
  projectDescriptionDeferred,
} from "../description-pages";
import { getSubtaskCounts } from "../get-subtask-counts";

export type GetTasksOptions = {
  publicOnly?: boolean;
  assigneeId?: string;
  dueAfter?: string;
  dueBefore?: string;
  limit?: number;
  page?: number;
  priority?: string;
  sortBy?:
    | "createdAt"
    | "priority"
    | "dueDate"
    | "position"
    | "title"
    | "number";
  sortOrder?: "asc" | "desc";
  status?: string;
};

const priorityCaseExpr = sql<number>`CASE
  WHEN ${taskTable.priority} = 'urgent' THEN 4
  WHEN ${taskTable.priority} = 'high' THEN 3
  WHEN ${taskTable.priority} = 'medium' THEN 2
  WHEN ${taskTable.priority} = 'low' THEN 1
  ELSE 0
END`;

function buildOrderBy(
  sortBy: GetTasksOptions["sortBy"],
  sortOrder: GetTasksOptions["sortOrder"],
): SQL {
  const direction = sortOrder === "desc" ? desc : asc;

  switch (sortBy) {
    case "createdAt":
      return direction(taskTable.createdAt);
    case "priority":
      return direction(priorityCaseExpr);
    case "dueDate":
      return direction(taskTable.dueDate);
    case "title":
      return direction(taskTable.title);
    case "number":
      return direction(taskTable.number);
    default:
      return direction(taskTable.position);
  }
}

async function getTasks(
  projectId: string,
  options: GetTasksOptions = {},
  userId?: string,
) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const [boardProject] = await db
    .select({
      description: boardProjectDescription,
      descriptionDeferred: projectDescriptionDeferred,
    })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .limit(1);

  const conditions = [eq(taskTable.projectId, projectId)];

  if (options.status) {
    conditions.push(eq(taskTable.status, options.status));
  }

  if (options.priority) {
    conditions.push(eq(taskTable.priority, options.priority));
  }

  if (options.assigneeId) {
    conditions.push(eq(taskTable.userId, options.assigneeId));
  }

  if (options.dueBefore) {
    conditions.push(lte(taskTable.dueDate, new Date(options.dueBefore)));
  }

  if (options.dueAfter) {
    conditions.push(gte(taskTable.dueDate, new Date(options.dueAfter)));
  }

  const whereClause = and(...conditions);
  assertPaginationBound(options.page, 1_000_000);
  assertPaginationBound(options.limit, 100);
  const page = options.page ?? 1;
  const pageSize = options.limit ?? 50;
  const offset = (page - 1) * pageSize;

  const orderByClause = buildOrderBy(
    options.sortBy ?? "position",
    options.sortOrder ?? "asc",
  );

  const [taskCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskTable)
    .where(whereClause);

  const total = Number(taskCount?.count ?? 0);

  const taskSelection = {
    id: taskTable.id,
    title: taskTable.title,
    number: taskTable.number,
    description: boardDescription,
    descriptionDeferred,
    status: taskTable.status,
    priority: taskTable.priority,
    startDate: taskTable.startDate,
    dueDate: taskTable.dueDate,
    position: taskTable.position,
    recurrence: taskTable.recurrence,
    createdAt: taskTable.createdAt,
    userId: taskTable.userId,
    assigneeName: userTable.name,
    assigneeId: userTable.id,
    assigneeImage: userTable.image,
    projectId: taskTable.projectId,
  };

  const query = db
    .select(taskSelection)
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(whereClause)
    .orderBy(orderByClause, asc(taskTable.id));

  const paginatedTasks = await query.limit(pageSize).offset(offset);
  const revision = await projectBoardRevision(projectId);

  const taskIds = paginatedTasks.map((task) => task.id);

  const labelsData =
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

  const externalLinksData =
    taskIds.length > 0
      ? await db
          .select()
          .from(externalLinkTable)
          .where(inArray(externalLinkTable.taskId, taskIds))
      : [];

  const taskLabelsMap = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  for (const label of labelsData) {
    if (label.taskId) {
      if (!taskLabelsMap.has(label.taskId)) {
        taskLabelsMap.set(label.taskId, []);
      }
      taskLabelsMap.get(label.taskId)?.push({
        id: label.id,
        name: label.name,
        color: label.color,
      });
    }
  }

  const taskExternalLinksMap = new Map<
    string,
    Array<{
      id: string;
      taskId: string;
      integrationId: string | null;
      resourceType: string;
      externalId: string;
      url: string;
      title: string | null;
      metadata: Record<string, unknown> | null;
    }>
  >();
  for (const externalLink of externalLinksData) {
    if (!taskExternalLinksMap.has(externalLink.taskId)) {
      taskExternalLinksMap.set(externalLink.taskId, []);
    }
    taskExternalLinksMap.get(externalLink.taskId)?.push({
      ...externalLink,
      metadata: externalLink.metadata
        ? JSON.parse(externalLink.metadata)
        : null,
    });
  }

  const projectColumns = await db
    .select()
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position));

  const subtaskCountMap = await getSubtaskCounts(
    db,
    taskIds,
    project.workspaceId,
    options.publicOnly ?? false,
    options.publicOnly ? undefined : userId,
  );

  const subtaskRelations =
    taskIds.length > 0
      ? await db
          .select({
            sourceTaskId: taskRelationTable.sourceTaskId,
            targetTaskId: taskRelationTable.targetTaskId,
          })
          .from(taskRelationTable)
          .where(
            and(
              eq(taskRelationTable.relationType, "subtask"),
              or(
                inArray(taskRelationTable.sourceTaskId, taskIds),
                inArray(taskRelationTable.targetTaskId, taskIds),
              ),
            ),
          )
      : [];

  const parentIdMap = new Map<string, string>();
  const childrenMap = new Map<string, string[]>();

  for (const relation of subtaskRelations) {
    parentIdMap.set(relation.targetTaskId, relation.sourceTaskId);
    const children = childrenMap.get(relation.sourceTaskId) ?? [];
    children.push(relation.targetTaskId);
    childrenMap.set(relation.sourceTaskId, children);
  }

  const enrichTask = (task: (typeof paginatedTasks)[number]) => {
    const counts = subtaskCountMap.get(task.id) ?? {
      completed: 0,
      total: 0,
    };
    const children = childrenMap.get(task.id) ?? [];

    return {
      ...task,
      recurrence: task.recurrence ?? null,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
      parentId: parentIdMap.get(task.id) ?? null,
      directSubtaskCount: children.length,
      completedSubtaskCount: counts.completed,
      subtaskCounts: counts,
    };
  };

  const columns = projectColumns.map((column) => ({
    id: column.slug,
    slug: column.slug,
    name: column.name,
    icon: column.icon,
    isFinal: column.isFinal,
    position: column.position,
    tasks: paginatedTasks
      .filter((task) => task.status === column.slug)
      .map(enrichTask),
  }));

  const archivedTasks = paginatedTasks
    .filter((task) => task.status === "archived")
    .map(enrichTask);

  const plannedTasks = paginatedTasks
    .filter((task) => task.status === "planned")
    .map(enrichTask);

  return {
    data: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      icon: project.icon,
      description: boardProject?.description ?? null,
      descriptionDeferred: boardProject?.descriptionDeferred ?? false,
      isPublic: project.isPublic,
      workspaceId: project.workspaceId,
      backgroundVersion: project.backgroundVersion,
      columns,
      archivedTasks,
      plannedTasks,
    },
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      revision,
      relatedPage: 1,
      relatedPageSize: pageSize,
      relatedTotalPages: 1,
    },
  };
}

function assertPaginationBound(value: number | undefined, max: number) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new HTTPException(400, {
      message: `Invalid task pagination or filters`,
    });
  }
}

async function projectBoardRevision(projectId: string) {
  const result = await db.execute<{ revision: string }>(sql`
    SELECT md5(concat_ws(':',
      (SELECT count(*)::text || ':' || coalesce(max(task.xmin::text), '') || ':' ||
          coalesce(string_agg(
            coalesce(assignee.name, '') || ':' || coalesce(assignee.image, ''),
            ',' ORDER BY task.id
          ), '')
        FROM task
        LEFT JOIN "user" assignee ON assignee.id = task.assignee_id
        WHERE task.project_id = ${projectId}),
      (SELECT count(*)::text || ':' || coalesce(max(label.xmin::text), '') || ':' ||
          coalesce(string_agg(label.name || ':' || label.color, ',' ORDER BY label.id), '')
        FROM label
        INNER JOIN task ON task.id = label.task_id
        WHERE task.project_id = ${projectId}),
      (SELECT count(*)::text || ':' || coalesce(max(external_link.xmin::text), '')
        FROM external_link
        INNER JOIN task ON task.id = external_link.task_id
        WHERE task.project_id = ${projectId}),
      (SELECT count(*)::text || ':' || coalesce(max("column".xmin::text), '')
        FROM "column" WHERE project_id = ${projectId}),
      (SELECT coalesce(name, '') || ':' || coalesce(is_public::text, '') || ':' || coalesce(xmin::text, '')
        FROM project WHERE id = ${projectId}),
      (SELECT coalesce(string_agg(
          child.id || ':' || child.status || ':' || coalesce(child.xmin::text, ''),
          ',' ORDER BY relation.id
        ), '')
        FROM task_relation relation
        INNER JOIN task parent ON parent.id = relation.source_task_id
        INNER JOIN task child ON child.id = relation.target_task_id
        INNER JOIN project child_project ON child_project.id = child.project_id
        WHERE parent.project_id = ${projectId}
          AND relation.relation_type = 'subtask'
          AND child_project.is_public = true
          AND child_project.workspace_id = (
            SELECT workspace_id FROM project WHERE id = ${projectId}
          ))
    )) AS revision
  `);
  return result.rows[0]?.revision ?? "0";
}

export default getTasks;
