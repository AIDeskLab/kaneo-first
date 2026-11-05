import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { filterUsersWithProjectAccess } from "../../project-access/filter-users-with-project-access";
import {
  NO_PROJECT_ACCESS,
  NOT_ASSIGNABLE,
} from "../../utils/assert-assignable-user";
import { resolveImportAssignees } from "../resolve-import-assignees";
import { resolveImportTaskStatus } from "../resolve-import-task-status";
import { coercePriority, VIRTUAL_STATUSES } from "../validate-task-fields";
import { claimTaskNumber } from "./claim-task-numbers";
import { nextTaskPosition } from "./next-task-position";
import { lockWorkspaceAssignees } from "./workspace-assignee-lock";

export type ImportTask = {
  title: string;
  description?: string;
  status: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
  userId?: string | null;
};

async function importTasks(
  projectId: string,
  tasksToImport: ImportTask[],
  currentUserId?: string,
) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const assigneeIds = [
    ...new Set(
      tasksToImport
        .map((task) => task.userId?.trim())
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];
  const results: Array<{
    success: boolean;
    task: typeof taskTable.$inferSelect | ImportTask;
    warnings?: string[];
    error?: string;
  }> = [];
  const { assignees, assignableIds, columns } = await db.transaction(
    async (tx) => {
      await lockWorkspaceAssignees(tx, project.workspaceId, assigneeIds);
      const assignees = await resolveImportAssignees(
        assigneeIds,
        project.workspaceId,
        tx,
      );
      const assignableIds = await filterUsersWithProjectAccess(
        assignees.values(),
        projectId,
        tx,
      );
      const columns = await tx
        .select({ slug: columnTable.slug, name: columnTable.name })
        .from(columnTable)
        .where(eq(columnTable.projectId, projectId))
        .orderBy(asc(columnTable.position));
      return { assignees, assignableIds, columns };
    },
  );

  for (const taskData of tasksToImport) {
    try {
      const reference = taskData.userId?.trim() || null;
      const assigneeId = reference ? assignees.get(reference) : null;
      if (reference && (!assigneeId || !assignableIds.has(assigneeId))) {
        results.push({
          success: false,
          error: assigneeId ? NO_PROJECT_ACCESS : NOT_ASSIGNABLE,
          task: taskData,
        });
        continue;
      }
      const resolved = resolveImportTaskStatus(taskData.status, columns);
      if ("error" in resolved) {
        results.push({
          success: false,
          error: resolved.error,
          task: taskData,
        });
        continue;
      }
      const { status, warning: statusWarning } = resolved;
      const { priority, warning: priorityWarning } = coercePriority(
        taskData.priority || "low",
      );
      const warnings = [statusWarning, priorityWarning].filter(
        (warning): warning is string => Boolean(warning),
      );

      const createdTask = await db.transaction(async (tx) => {
        const taskNumber = await claimTaskNumber(projectId, tx);
        // Recheck the snapshot's column and retain it until the insert commits.
        const [column] = await tx
          .select({ id: columnTable.id })
          .from(columnTable)
          .where(
            and(
              eq(columnTable.projectId, projectId),
              eq(columnTable.slug, status),
            ),
          )
          .limit(1)
          .for("key share");
        const storedStatus =
          column || VIRTUAL_STATUSES.some((virtual) => virtual === status)
            ? status
            : "planned";
        if (storedStatus !== status) {
          warnings.push(
            `Status "${status}" no longer has a column. Mapped to "planned".`,
          );
        }
        const position = await nextTaskPosition(
          tx,
          projectId,
          storedStatus,
          column?.id ?? null,
        );

        const [task] = await tx
          .insert(taskTable)
          .values({
            projectId,
            userId: assigneeId,
            title: taskData.title,
            status: storedStatus,
            columnId: column?.id ?? null,
            position,
            startDate: taskData.startDate ? new Date(taskData.startDate) : null,
            dueDate: taskData.dueDate ? new Date(taskData.dueDate) : null,
            description: taskData.description || "",
            priority,
            number: taskNumber,
          })
          .returning();
        return task;
      });

      if (createdTask) {
        await publishEvent(
          "task.created",
          {
            ...createdTask,
            taskId: createdTask.id,
            userId: createdTask.userId ?? "",
            currentUserId: currentUserId ?? "",
            type: "create",
            content: "imported the task",
          },
          { waitForHandlers: true },
        );

        results.push({
          success: true,
          task: createdTask,
          ...(warnings.length > 0 && { warnings }),
        });
      } else {
        results.push({
          success: false,
          error: "Failed to create task",
          task: taskData,
        });
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      results.push({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        task: taskData,
      });
    }
  }

  return {
    importedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
    },
    results: {
      total: tasksToImport.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      tasks: results,
    },
  };
}

export default importTasks;
