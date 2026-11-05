import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { standardSchemaValidationHook } from "../errors/validation-error";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import db from "../database";
import {
  assetTable,
  projectTable,
  taskTable,
  workspaceTable,
} from "../database/schema";
import { taskSchema } from "../schemas";
import { withVerifiedStorageObject } from "../storage/cleanup-queue";
import {
  assertTaskImageKeyMatchesContext,
  createTaskImageUploadUrl,
  InvalidUploadedAssetError,
  isImageContentType,
  validateTaskAssetUploadInput,
  verifyTaskAssetUpload,
} from "../storage/s3";
import { normalizeApiServerUrl } from "../utils/openapi-spec";
import {
  hasWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import {
  validateAndParseDate,
  validateDateRange,
} from "../utils/validate-dates";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import bulkUpdateTasks from "./controllers/bulk-update-tasks";
import createTask from "./controllers/create-task";
import deleteTask from "./controllers/delete-task";
import duplicateTask from "./controllers/duplicate-task";
import getAssignedTasks from "./controllers/get-assigned-tasks";
import getTaskByTicketId from "./controllers/get-task-by-ticket-id";
import { MAX_TASK_POSITION } from "./controllers/next-task-position";
import reorderTasks from "./controllers/reorder-tasks";
import {
  finalizeStagedTaskAsset,
  stageTaskAssetUpload,
} from "./controllers/stage-task-asset";
import updateTaskRecurrence from "./controllers/update-task-recurrence";
import "./recurrence/subscribe";
import {
  getDeferredDescriptionMatches,
  getDescriptionPage,
} from "./description-pages";
import exportTasks from "./controllers/export-tasks";
import getMyTasks from "./controllers/get-my-tasks";
import getTask from "./controllers/get-task";
import getTasks from "./controllers/get-tasks";
import importTasks from "./controllers/import-tasks";
import moveTask from "./controllers/move-task";
import {
  requireBulkTaskPermission,
  requireCreateTaskAssigneePermission,
  requireImportTaskAssigneePermission,
  requireTaskAssigneePermission,
} from "./controllers/require-task-permission";
import updateTask from "./controllers/update-task";
import updateTaskAssignee from "./controllers/update-task-assignee";
import updateTaskDescription from "./controllers/update-task-description";
import updateTaskDueDate from "./controllers/update-task-due-date";
import updateTaskPriority from "./controllers/update-task-priority";
import updateTaskStatus from "./controllers/update-task-status";
import updateTaskTitle from "./controllers/update-task-title";
import { taskRecurrenceSchema, type TaskRecurrence } from "./recurrence/schema";
import { VALID_PRIORITIES } from "./validate-task-fields";

function parseTaskRecurrence(value: unknown): TaskRecurrence {
  const parsed = taskRecurrenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Invalid recurrence" });
  }
  return parsed.data;
}

const task = new Hono<{
  Variables: {
    userId: string;
    authorizedTaskAssignee?: { userId: string | null };
    apiKey?: { permissions?: Record<string, string[]> | null };
  };
}>()
  .get(
    "/tasks/:projectId",
    describeRoute({
      operationId: "listTasks",
      tags: ["Tasks"],
      description: "Get all tasks for a specific project",
      responses: {
        200: {
          description: "Project with tasks organized by columns",
          content: {
            "application/json": { schema: resolver(v.any()) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "query",
      v.optional(
        v.object({
          status: v.optional(v.string()),
          priority: v.optional(v.string()),
          assigneeId: v.optional(v.string()),
          page: v.optional(v.pipe(v.string(), v.transform(Number))),
          relatedPage: v.optional(
            v.pipe(
              v.string(),
              v.check(
                (value) =>
                  /^[1-9]\d*$/.test(value) && Number(value) <= 1_000_000,
              ),
              v.transform(Number),
            ),
          ),
          limit: v.optional(v.pipe(v.string(), v.transform(Number))),
          sortBy: v.optional(
            v.picklist([
              "createdAt",
              "priority",
              "dueDate",
              "position",
              "title",
              "number",
            ]),
          ),
          sortOrder: v.optional(v.picklist(["asc", "desc"])),
          dueBefore: v.optional(v.string()),
          dueAfter: v.optional(v.string()),
        }),
      ),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ project: ["read"], task: ["read"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const filters = c.req.valid("query") || {};

      const tasks = await getTasks(projectId, filters, c.get("userId"));

      return c.json(tasks);
    },
  )
  .get(
    "/my",
    describeRoute({
      operationId: "getMyTasks",
      tags: ["Tasks"],
      description:
        "Get all tasks assigned to the current user across all projects",
      responses: {
        200: {
          description: "Tasks assigned to the current user",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("query", v.object({ status: v.optional(v.string()) })),
    async (c) => {
      const { status } = c.req.valid("query") || {};
      const userId = c.get("userId");
      return c.json(await getMyTasks(userId, status));
    },
  )
  .patch(
    "/bulk",
    describeRoute({
      operationId: "bulkUpdateTasks",
      tags: ["Tasks"],
      description: "Perform bulk operations on multiple tasks",
      responses: {
        200: {
          description: "Bulk operation completed successfully",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  success: v.boolean(),
                  updatedCount: v.number(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        taskIds: v.pipe(v.array(v.string()), v.minLength(1)),
        operation: v.picklist([
          "updateStatus",
          "updatePriority",
          "updateAssignee",
          "delete",
          "addLabel",
          "removeLabel",
          "updateDueDate",
        ] as const),
        value: v.optional(v.nullable(v.string())),
      }),
    ),
    workspaceAccess.fromTasks(),
    requireBulkTaskPermission,
    async (c) => {
      const { taskIds, operation, value } = c.req.valid("json");
      const userId = c.get("userId");

      if (!userId) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }

      if (
        operation !== "delete" &&
        operation !== "updateDueDate" &&
        value === undefined
      ) {
        throw new HTTPException(400, {
          message: "Value is required for this operation",
        });
      }

      const result = await bulkUpdateTasks({
        taskIds,
        operation,
        value,
        userId,
      });

      return c.json(result);
    },
  )
  .post(
    "/reorder",
    describeRoute({
      operationId: "reorderTasks",
      tags: ["Tasks"],
      description: "Reorder tasks within a project",
    }),
    validator(
      "json",
      v.object({
        projectId: v.string(),
        tasks: v.array(
          v.object({
            id: v.string(),
            position: v.number(),
            status: v.optional(v.string()),
          }),
        ),
        expectedTasks: v.optional(
          v.array(
            v.object({
              id: v.string(),
              position: v.nullable(v.number()),
              status: v.string(),
            }),
          ),
        ),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { projectId, tasks, expectedTasks } = c.req.valid("json");
      return c.json(
        await reorderTasks(projectId, tasks, c.get("userId"), expectedTasks),
      );
    },
  )
  .post(
    "/:projectId",
    describeRoute({
      operationId: "createTask",
      tags: ["Tasks"],
      description: "Create a new task in a project",
      responses: {
        200: {
          description: "Task created successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        title: v.string(),
        description: v.string(),
        startDate: v.optional(v.string()),
        dueDate: v.optional(v.string()),
        priority: v.picklist(VALID_PRIORITIES),
        status: v.string(),
        userId: v.optional(v.string()),
        recurrence: v.optional(
          v.object({
            frequency: v.picklist(["daily", "weekly", "monthly", "yearly"]),
            interval: v.pipe(v.number(), v.minValue(1), v.maxValue(99)),
            weekdays: v.optional(v.pipe(v.array(v.number()), v.minLength(1))),
            timeZone: v.string(),
          }),
        ),
        draftAssetIds: v.optional(
          v.pipe(v.array(v.string()), v.maxLength(100)),
        ),
        customFields: v.optional(
          v.array(v.object({ fieldId: v.string(), value: v.string() })),
        ),
      }),
      standardSchemaValidationHook,
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["create"] }),
    requireCreateTaskAssigneePermission,
    async (c) => {
      const { projectId } = c.req.param();
      const {
        title,
        description,
        startDate,
        dueDate,
        priority,
        status,
        userId,
        recurrence,
        draftAssetIds,
        customFields,
      } = c.req.valid("json");

      const parsedStartDate =
        startDate !== undefined
          ? validateAndParseDate(startDate, "startDate")
          : undefined;
      const parsedDueDate =
        dueDate !== undefined
          ? validateAndParseDate(dueDate, "dueDate")
          : undefined;

      validateDateRange(parsedStartDate, parsedDueDate);

      const task = await createTask({
        projectId,
        currentUserId: c.get("userId"),
        userId: userId,
        title,
        description,
        startDate: parsedStartDate,
        dueDate: parsedDueDate,
        priority,
        status,
        recurrence: recurrence ? parseTaskRecurrence(recurrence) : undefined,
        draftAssetIds,
        customFields,
      });

      return c.json(task);
    },
  )
  .get(
    "/assigned",
    describeRoute({
      operationId: "listAssignedTasks",
      tags: ["Tasks"],
      description: "List tasks assigned to the current user in a workspace",
    }),
    validator(
      "query",
      v.object({
        workspaceId: v.string(),
        countOnly: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromQuery(),
    requireWorkspacePermission({ project: ["read"], task: ["read"] }),
    async (c) => {
      const { workspaceId, countOnly } = c.req.valid("query");
      return c.json(
        await getAssignedTasks(
          workspaceId,
          c.get("userId"),
          countOnly === "true",
        ),
      );
    },
  )
  .get(
    "/:id/description",
    describeRoute({
      operationId: "getTaskDescriptionPage",
      tags: ["Tasks"],
      description: "Read one page of a task description",
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["read"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const offsetRaw = c.req.query("offset");
      const version = c.req.query("version");
      const canonicalOffset =
        offsetRaw == null ||
        offsetRaw === "" ||
        /^(?:0|[1-9]\d*)$/.test(offsetRaw);
      const offset =
        offsetRaw == null || offsetRaw === "" ? 0 : Number(offsetRaw);
      if (
        !canonicalOffset ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 2_147_483_647 ||
        (version !== undefined && !/^[0-9]{1,10}$/.test(version))
      ) {
        throw new HTTPException(400, {
          message: "Invalid description cursor",
        });
      }
      return c.json(await getDescriptionPage(id, { offset, version }));
    },
  )
  .get(
    "/:id",
    describeRoute({
      operationId: "getTask",
      tags: ["Tasks"],
      description: "Get a specific task by ID",
      responses: {
        200: {
          description: "Task details",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "query",
      v.object({
        view: v.optional(v.picklist(["detail", "board"])),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["read"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { view } = c.req.valid("query");
      const task = await getTask(id, view === "board", c.get("userId"));

      return c.json(task);
    },
  )
  .put(
    "/move/:id",
    describeRoute({
      operationId: "moveTask",
      tags: ["Tasks"],
      description: "Move a task to another project",
      responses: {
        200: {
          description: "Task moved successfully",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  task: taskSchema,
                  sourceProjectId: v.string(),
                  destinationProjectId: v.string(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        destinationProjectId: v.string(),
        destinationStatus: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { destinationProjectId, destinationStatus } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const result = await moveTask({
        taskId: id,
        destinationProjectId,
        destinationStatus,
        currentUserId,
      });

      return c.json(result);
    },
  )
  .put(
    "/:id",
    describeRoute({
      operationId: "updateTask",
      tags: ["Tasks"],
      description: "Update all fields of a task",
      responses: {
        200: {
          description: "Task updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        startDate: v.optional(v.string()),
        dueDate: v.optional(v.string()),
        priority: v.picklist(VALID_PRIORITIES),
        status: v.string(),
        projectId: v.string(),
        position: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.maxValue(MAX_TASK_POSITION),
        ),
        userId: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    requireTaskAssigneePermission,
    async (c) => {
      const { id } = c.req.valid("param");
      const {
        title,
        description,
        startDate,
        dueDate,
        priority,
        status,
        projectId,
        position,
        userId,
      } = c.req.valid("json");

      const currentUserId = c.get("userId");

      const parsedStartDate =
        startDate !== undefined
          ? validateAndParseDate(startDate, "startDate")
          : undefined;
      const parsedDueDate =
        dueDate !== undefined
          ? validateAndParseDate(dueDate, "dueDate")
          : undefined;

      validateDateRange(parsedStartDate, parsedDueDate);

      const task = await updateTask(
        id,
        title,
        status,
        parsedStartDate,
        parsedDueDate,
        projectId,
        description,
        priority,
        position,
        userId,
        currentUserId,
        c.get("authorizedTaskAssignee"),
      );

      return c.json(task);
    },
  )
  .get(
    "/export/:projectId",
    describeRoute({
      operationId: "exportTasks",
      tags: ["Tasks"],
      description: "Export all tasks from a project",
      responses: {
        200: {
          description: "Exported tasks data",
          content: {
            "application/json": { schema: resolver(v.any()) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ project: ["read"], task: ["read"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");

      const exportData = await exportTasks(projectId);

      return c.json(exportData);
    },
  )
  .post(
    "/import/:projectId",
    describeRoute({
      operationId: "importTasks",
      tags: ["Tasks"],
      description: "Import multiple tasks into a project",
      responses: {
        200: {
          description: "Tasks imported successfully",
          content: {
            "application/json": { schema: resolver(v.any()) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        tasks: v.array(
          v.object({
            title: v.string(),
            description: v.optional(v.string()),
            status: v.string(),
            priority: v.optional(v.string()),
            startDate: v.optional(v.nullable(v.string())),
            dueDate: v.optional(v.nullable(v.string())),
            userId: v.optional(v.nullable(v.string())),
          }),
        ),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["create"] }),
    requireImportTaskAssigneePermission,
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { tasks } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const result = await importTasks(projectId, tasks, currentUserId);

      return c.json(result);
    },
  )
  .delete(
    "/:id",
    describeRoute({
      operationId: "deleteTask",
      tags: ["Tasks"],
      description: "Delete a task by ID",
      responses: {
        200: {
          description: "Task deleted successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["delete"] }),
    async (c) => {
      const { id } = c.req.valid("param");

      const currentUserId = c.get("userId");
      const task = await deleteTask(id, currentUserId);

      return c.json(task);
    },
  )
  .put(
    "/status/:id",
    describeRoute({
      operationId: "updateTaskStatus",
      tags: ["Tasks"],
      description: "Update only the status of a task",
      responses: {
        200: {
          description: "Task status updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ status: v.string() })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { status } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const task = await updateTaskStatus({ id, status, currentUserId });

      return c.json(task);
    },
  )
  .put(
    "/priority/:id",
    describeRoute({
      operationId: "updateTaskPriority",
      tags: ["Tasks"],
      description: "Update only the priority of a task",
      responses: {
        200: {
          description: "Task priority updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ priority: v.picklist(VALID_PRIORITIES) })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { priority } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const task = await updateTaskPriority({ id, priority, currentUserId });

      return c.json(task);
    },
  )
  .put(
    "/assignee/:id",
    describeRoute({
      operationId: "updateTaskAssignee",
      tags: ["Tasks"],
      description: "Assign or unassign a task to a user",
      responses: {
        200: {
          description: "Task assignee updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ userId: v.nullable(v.string()) })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["assign"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { userId } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const task = await updateTaskAssignee({ id, userId, currentUserId });

      return c.json(task);
    },
  )
  .put(
    "/due-date/:id",
    describeRoute({
      operationId: "updateTaskDueDate",
      tags: ["Tasks"],
      description: "Update only the due date of a task",
      responses: {
        200: {
          description: "Task due date updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ dueDate: v.optional(v.string()) })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { dueDate = null } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const task = await updateTaskDueDate({
        id,
        dueDate: dueDate ? validateAndParseDate(dueDate, "dueDate") : null,
        currentUserId,
      });

      return c.json(task);
    },
  )

  .put(
    "/title/:id",
    describeRoute({
      operationId: "updateTaskTitle",
      tags: ["Tasks"],
      description: "Update only the title of a task",
      responses: {
        200: {
          description: "Task title updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ title: v.string() })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { title } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const task = await updateTaskTitle({ id, title, currentUserId });

      return c.json(task);
    },
  )

  .put(
    "/image-upload/:id",
    describeRoute({
      operationId: "createTaskImageUpload",
      tags: ["Tasks"],
      description:
        "Create a presigned image upload URL for a task description or comment",
      responses: {
        200: {
          description: "Image upload URL created successfully",
          content: {
            "application/json": { schema: resolver(v.any()) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        filename: v.string(),
        contentType: v.string(),
        size: v.number(),
        surface: v.picklist(["description", "comment"] as const),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { filename, contentType, size, surface } = c.req.valid("json");

      try {
        validateTaskAssetUploadInput(contentType, size);
      } catch (error) {
        throw new HTTPException(400, {
          message:
            error instanceof Error
              ? error.message
              : "Invalid image upload request",
        });
      }

      const [taskContext] = await db
        .select({
          taskId: taskTable.id,
          projectId: taskTable.projectId,
          workspaceId: workspaceTable.id,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .innerJoin(
          workspaceTable,
          eq(projectTable.workspaceId, workspaceTable.id),
        )
        .where(eq(taskTable.id, id))
        .limit(1);

      if (!taskContext) {
        throw new HTTPException(404, { message: "Task not found" });
      }

      try {
        const upload = await createTaskImageUploadUrl({
          workspaceId: taskContext.workspaceId,
          projectId: taskContext.projectId,
          taskId: taskContext.taskId,
          surface,
          filename,
          contentType,
          size,
        });

        return c.json(upload);
      } catch (error) {
        throw new HTTPException(503, {
          message:
            error instanceof Error
              ? error.message
              : "Image uploads are not configured",
        });
      }
    },
  )
  .post(
    "/image-upload/:id/finalize",
    describeRoute({
      operationId: "finalizeTaskImageUpload",
      tags: ["Tasks"],
      description:
        "Finalize an uploaded task image and create a private asset record",
      responses: {
        200: {
          description: "Image upload finalized successfully",
          content: {
            "application/json": { schema: resolver(v.any()) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        key: v.string(),
        filename: v.string(),
        contentType: v.string(),
        size: v.number(),
        surface: v.picklist(["description", "comment"] as const),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { key, filename, contentType, size, surface } = c.req.valid("json");
      const userId = c.get("userId");

      try {
        validateTaskAssetUploadInput(contentType, size);
      } catch (error) {
        throw new HTTPException(400, {
          message:
            error instanceof Error
              ? error.message
              : "Invalid image upload request",
        });
      }

      const [taskContext] = await db
        .select({
          taskId: taskTable.id,
          projectId: taskTable.projectId,
          workspaceId: workspaceTable.id,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .innerJoin(
          workspaceTable,
          eq(projectTable.workspaceId, workspaceTable.id),
        )
        .where(eq(taskTable.id, id))
        .limit(1);

      if (!taskContext) {
        throw new HTTPException(404, { message: "Task not found" });
      }

      const normalizedKey = key.trim();
      if (
        !assertTaskImageKeyMatchesContext(normalizedKey, {
          workspaceId: taskContext.workspaceId,
          projectId: taskContext.projectId,
          taskId: taskContext.taskId,
          surface,
        })
      ) {
        throw new HTTPException(400, {
          message: "Image upload key does not match the task context.",
        });
      }

      const asset = await withVerifiedStorageObject(
        normalizedKey,
        async () => {
          try {
            return await verifyTaskAssetUpload(normalizedKey, {
              size,
              contentType,
            });
          } catch (error) {
            throw new HTTPException(
              error instanceof InvalidUploadedAssetError ? 400 : 503,
              {
                message:
                  error instanceof InvalidUploadedAssetError
                    ? error.message
                    : "Unable to verify uploaded object.",
              },
            );
          }
        },
        async (tx, uploaded) => {
          const [existingAsset] = await tx
            .select({ id: assetTable.id })
            .from(assetTable)
            .where(eq(assetTable.objectKey, normalizedKey))
            .limit(1);

          const [saved] = existingAsset
            ? await tx
                .update(assetTable)
                .set({
                  workspaceId: taskContext.workspaceId,
                  projectId: taskContext.projectId,
                  taskId: taskContext.taskId,
                  filename,
                  mimeType: uploaded.contentType,
                  size: uploaded.size,
                  kind: isImageContentType(uploaded.contentType)
                    ? "image"
                    : "attachment",
                  surface,
                  createdBy: userId || null,
                })
                .where(eq(assetTable.id, existingAsset.id))
                .returning({
                  id: assetTable.id,
                })
            : await tx
                .insert(assetTable)
                .values({
                  workspaceId: taskContext.workspaceId,
                  projectId: taskContext.projectId,
                  taskId: taskContext.taskId,
                  objectKey: normalizedKey,
                  filename,
                  mimeType: uploaded.contentType,
                  size: uploaded.size,
                  kind: isImageContentType(uploaded.contentType)
                    ? "image"
                    : "attachment",
                  surface,
                  createdBy: userId || null,
                })
                .returning({
                  id: assetTable.id,
                });
          return saved;
        },
      );

      if (!asset) {
        throw new HTTPException(500, {
          message: "Failed to save asset",
        });
      }

      const apiBaseUrl = normalizeApiServerUrl(
        process.env.KANEO_API_URL || new URL(c.req.url).origin,
      );
      return c.json({
        id: asset.id,
        url: `${apiBaseUrl}/asset/${asset.id}`,
      });
    },
  )
  .put(
    "/description/:id",
    describeRoute({
      operationId: "updateTaskDescription",
      tags: ["Tasks"],
      description: "Update only the description of a task",
      responses: {
        200: {
          description: "Task description updated successfully",
          content: {
            "application/json": { schema: resolver(taskSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ description: v.string() })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { description } = c.req.valid("json");
      const currentUserId = c.get("userId");

      const task = await updateTaskDescription({
        id,
        description,
        currentUserId,
      });

      return c.json(task);
    },
  )
  .get(
    "/description-matches/:projectId",
    describeRoute({
      operationId: "searchTaskDescriptions",
      tags: ["Tasks"],
      description: "Find tasks whose description contains a query",
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "query",
      v.object({
        query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
        after: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["read"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { query, after } = c.req.valid("query");
      return c.json(
        await getDeferredDescriptionMatches(projectId, query, after),
      );
    },
  )
  .post(
    "/draft-upload/:projectId",
    describeRoute({
      operationId: "stageTaskAssetUpload",
      tags: ["Tasks"],
      description: "Prepare an upload for a file that is not attached yet",
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        filename: v.string(),
        contentType: v.string(),
        size: v.number(),
        surface: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["create"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { filename, contentType, size, surface } = c.req.valid("json");
      if (surface != null && surface !== "description") {
        throw new HTTPException(400, {
          message: "Staged uploads only support the description surface",
        });
      }
      return c.json(
        await stageTaskAssetUpload(projectId, c.get("userId"), {
          filename,
          contentType,
          size,
        }),
      );
    },
  )
  .post(
    "/draft-upload/:projectId/finalize",
    describeRoute({
      operationId: "finalizeStagedTaskAsset",
      tags: ["Tasks"],
      description: "Finish a staged task file upload",
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        filename: v.string(),
        contentType: v.string(),
        size: v.number(),
        key: v.string(),
        surface: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["create"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { filename, contentType, size, key, surface } = c.req.valid("json");
      if (surface != null && surface !== "description") {
        throw new HTTPException(400, {
          message: "Staged uploads only support the description surface",
        });
      }
      const asset = await finalizeStagedTaskAsset(projectId, c.get("userId"), {
        filename,
        contentType,
        size,
        key,
      });
      const base = normalizeApiServerUrl(
        process.env.KANEO_API_URL || new URL(c.req.url).origin,
      );
      return c.json({ id: asset.id, url: `${base}/asset/${asset.id}` });
    },
  )
  .post(
    "/duplicate/:id",
    describeRoute({
      operationId: "duplicateTask",
      tags: ["Tasks"],
      description: "Duplicate a task",
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ title: v.optional(v.string()) })),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["create"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { title } = c.req.valid("json");
      return c.json(
        await duplicateTask({
          taskId: id,
          title,
          currentUserId: c.get("userId"),
          canUpdateTasks: await hasWorkspacePermission(c, {
            task: ["update"],
          }),
        }),
      );
    },
  )
  .get(
    "/by-ticket-id/:ticketId",
    describeRoute({
      operationId: "getTaskByTicketId",
      tags: ["Tasks"],
      description: "Resolve a task from its ticket id",
    }),
    validator("param", v.object({ ticketId: v.string() })),
    validator(
      "query",
      v.object({
        workspaceSlug: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        projectId: v.optional(v.string()),
      }),
    ),
    async (c) => {
      const { ticketId } = c.req.valid("param");
      const apiKey = c.get("apiKey") as
        | { permissions?: Record<string, string[]> | null }
        | undefined;
      return c.json(
        await getTaskByTicketId(
          ticketId,
          c.get("userId"),
          c.req.valid("query"),
          apiKey ? (apiKey.permissions ?? null) : undefined,
        ),
      );
    },
  )
  .put(
    "/recurrence/:id",
    describeRoute({
      operationId: "updateTaskRecurrence",
      tags: ["Tasks"],
      description: "Update a task recurrence rule",
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        recurrence: v.nullable(
          v.object({
            frequency: v.picklist(["daily", "weekly", "monthly", "yearly"]),
            interval: v.pipe(v.number(), v.minValue(1), v.maxValue(99)),
            weekdays: v.optional(v.pipe(v.array(v.number()), v.minLength(1))),
            timeZone: v.string(),
          }),
        ),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { recurrence } = c.req.valid("json");
      if (recurrence) {
        await requireWorkspacePermission({ task: ["create"] })(
          c,
          async () => {},
        );
      }
      return c.json(
        await updateTaskRecurrence({
          id,
          recurrence: recurrence ? parseTaskRecurrence(recurrence) : null,
          currentUserId: c.get("userId"),
        }),
      );
    },
  );

export default task;
