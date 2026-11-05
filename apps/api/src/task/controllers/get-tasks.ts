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
import { publicExternalLink } from "../../project/controllers/public-external-link";
import { boundedTaskRead } from "../bounded-read";
import { getSubtaskCounts } from "../get-subtask-counts";

export type GetTasksOptions = {
  publicOnly?: boolean;
  assigneeId?: string;
  dueAfter?: string;
  dueBefore?: string;
  limit?: number;
  page?: number;
  relatedPage?: number;
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

type TaskReadDb = Pick<typeof db, "select" | "execute" | "query">;

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

async function getTasksPage(
  database: TaskReadDb,
  projectId: string,
  options: GetTasksOptions = {},
  userId?: string,
) {
  const project = await database.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const [boardProject] = await database
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
  assertPaginationBound(options.relatedPage, 1_000_000);
  const page = options.page ?? 1;
  const pageSize = options.limit ?? 50;
  const offset = (page - 1) * pageSize;
  const relatedPage = options.relatedPage ?? 1;
  const relatedPageSize = 100;
  const relatedOffset = (relatedPage - 1) * relatedPageSize;

  const orderByClause = buildOrderBy(
    options.sortBy ?? "position",
    options.sortOrder ?? "asc",
  );

  const [taskCount] = await database
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

  const query = database
    .select(taskSelection)
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(whereClause)
    .orderBy(orderByClause, asc(taskTable.id));

  const paginatedTasks = await query.limit(pageSize).offset(offset);
  const revision = await projectBoardRevision(database, projectId);

  const taskIds = paginatedTasks.map((task) => task.id);

  const labelsData =
    taskIds.length > 0
      ? await database
          .select({
            id: labelTable.id,
            name: labelTable.name,
            color: labelTable.color,
            taskId: labelTable.taskId,
          })
          .from(labelTable)
          .where(inArray(labelTable.taskId, taskIds))
          .orderBy(asc(labelTable.id))
          .limit(relatedPageSize)
          .offset(relatedOffset)
      : [];

  const externalLinksData =
    taskIds.length > 0
      ? await database
          .select()
          .from(externalLinkTable)
          .where(inArray(externalLinkTable.taskId, taskIds))
          .orderBy(asc(externalLinkTable.id))
          .limit(relatedPageSize)
          .offset(relatedOffset)
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
    const parsed = {
      ...externalLink,
      metadata: parseMetadata(externalLink.metadata),
    };
    taskExternalLinksMap
      .get(externalLink.taskId)
      ?.push(options.publicOnly ? publicExternalLink(parsed) : parsed);
  }

  const projectColumns = await database
    .select()
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position), asc(columnTable.id))
    .limit(relatedPageSize)
    .offset(relatedOffset);
  const missingStatuses = [
    ...new Set(paginatedTasks.map((task) => task.status)),
  ].filter(
    (status) =>
      status !== "planned" &&
      status !== "archived" &&
      !projectColumns.some((column) => column.slug === status),
  );
  if (missingStatuses.length > 0) {
    const taskColumns = await database
      .select()
      .from(columnTable)
      .where(
        and(
          eq(columnTable.projectId, projectId),
          inArray(columnTable.slug, missingStatuses),
        ),
      )
      .orderBy(asc(columnTable.position), asc(columnTable.id))
      .limit(100);
    projectColumns.push(...taskColumns);
  }
  const [labelCountRow] = taskIds.length
    ? await database
        .select({ count: sql<number>`count(*)` })
        .from(labelTable)
        .where(inArray(labelTable.taskId, taskIds))
    : [{ count: 0 }];
  const [linkCountRow] = taskIds.length
    ? await database
        .select({ count: sql<number>`count(*)` })
        .from(externalLinkTable)
        .where(inArray(externalLinkTable.taskId, taskIds))
    : [{ count: 0 }];
  const [columnCountRow] = await database
    .select({ count: sql<number>`count(*)` })
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId));
  const relatedRevision = options.publicOnly
    ? await relatedBoardRevision(database, projectId)
    : undefined;

  const subtaskCountMap = await getSubtaskCounts(
    database,
    taskIds,
    project.workspaceId,
    options.publicOnly ?? false,
    options.publicOnly ? undefined : userId,
  );

  const subtaskRelations =
    taskIds.length > 0
      ? await database
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
      ...(relatedRevision ? { relatedRevision } : {}),
      relatedPage,
      relatedPageSize,
      relatedTotalPages: Math.max(
        1,
        Math.ceil(
          Math.max(
            Number(columnCountRow?.count ?? 0),
            Number(labelCountRow?.count ?? 0),
            Number(linkCountRow?.count ?? 0),
          ) / relatedPageSize,
        ),
      ),
    },
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function relatedBoardRevision(database: TaskReadDb, projectId: string) {
  const result = await database.execute<{ revision: string }>(sql`
    SELECT md5(concat_ws(':',
      (SELECT count(*)::text || ':' || coalesce(string_agg(
          label.id || ':' || label.name || ':' || label.color, ',' ORDER BY label.id
        ), '')
        FROM label
        INNER JOIN task ON task.id = label.task_id
        WHERE task.project_id = ${projectId}),
      (SELECT count(*)::text || ':' || coalesce(string_agg(
          external_link.id || ':' || coalesce(external_link.metadata, ''),
          ',' ORDER BY external_link.id
        ), '')
        FROM external_link
        INNER JOIN task ON task.id = external_link.task_id
        WHERE task.project_id = ${projectId})
    )) AS revision
  `);
  return result.rows[0]?.revision ?? "0";
}

function getTasks(
  projectId: string,
  options: GetTasksOptions = {},
  userId?: string,
) {
  return boundedTaskRead(
    (tx) =>
      getTasksPage(tx as unknown as TaskReadDb, projectId, options, userId),
    "Task list request took too long; retry later",
  );
}

function assertPaginationBound(value: number | undefined, max: number) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new HTTPException(400, {
      message: `Invalid task pagination or filters`,
    });
  }
}

async function projectBoardRevision(database: TaskReadDb, projectId: string) {
  const result = await database.execute<{ revision: string }>(sql`
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
