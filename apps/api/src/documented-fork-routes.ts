import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, errorResponse, jsonResponse, z } from "./openapi";
import { listProjectsQuery } from "./project/schema";
import { projectListSchema } from "./project/response";
import { boardSchema, bulkResultSchema, taskSchema } from "./task/response";
import {
  bulkUpdateBody,
  listTasksQuery,
  projectIdParam,
  taskParam,
} from "./task/schema";

// Project and task routers still serve through Hono. Register the operations
// the generated document must list so clients can see those paths and the
// Task and Project component schemas. Request handling stays on the routers.
export function registerForkRouteDocs(
  registry: OpenAPIHono["openAPIRegistry"],
) {
  registry.registerPath(
    createRoute({
      method: "get",
      path: "/project",
      operationId: "listProjects",
      tags: ["Projects"],
      summary: "List projects",
      description: "Get all projects in a workspace",
      request: { query: listProjectsQuery },
      responses: {
        200: jsonResponse(
          "List of projects with statistics",
          projectListSchema,
        ),
        400: errorResponse("Invalid query"),
      },
    }),
  );
  registry.registerPath(
    createRoute({
      method: "get",
      path: "/task/tasks/{projectId}",
      operationId: "listTasks",
      tags: ["Tasks"],
      summary: "List tasks",
      description: "Get tasks for a project, grouped into board columns",
      request: { params: projectIdParam, query: listTasksQuery },
      responses: {
        200: jsonResponse("Project board", boardSchema),
        400: errorResponse("Invalid query"),
      },
    }),
  );
  registry.registerPath(
    createRoute({
      method: "patch",
      path: "/task/bulk",
      operationId: "bulkUpdateTasks",
      tags: ["Tasks"],
      summary: "Update tasks in bulk",
      description: "Apply one operation to several tasks",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: bulkUpdateBody } },
        },
      },
      responses: {
        200: jsonResponse("Bulk operation completed", bulkResultSchema),
        400: errorResponse("Invalid bulk operation"),
      },
    }),
  );
  registry.registerPath(
    createRoute({
      method: "get",
      path: "/task/{id}",
      operationId: "getTask",
      tags: ["Tasks"],
      summary: "Get a task",
      description: "Get a task by ID",
      request: {
        params: taskParam,
        query: z.object({
          view: z.enum(["detail", "board"]).optional(),
        }),
      },
      responses: {
        200: jsonResponse("Task details", taskSchema),
        404: errorResponse("Task not found"),
      },
    }),
  );
}
