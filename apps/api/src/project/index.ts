import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { projectSchema } from "../schemas";
import {
  hasWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { validateWorkspaceAccess } from "../utils/validate-workspace-access";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import archiveProjectCtrl from "./controllers/archive-project";
import createProjectCtrl from "./controllers/create-project";
import deleteProjectCtrl from "./controllers/delete-project";
import getProjectCtrl from "./controllers/get-project";
import getProjectsCtrl from "./controllers/get-projects";
import moveProjectCtrl from "./controllers/move-project";
import {
  finalizeProjectBackground,
  getProjectBackground,
  prepareProjectBackgroundUpload,
  removeProjectBackground,
} from "./controllers/project-background";
import reorderProjectsCtrl from "./controllers/reorder-projects";
import unarchiveProjectCtrl from "./controllers/unarchive-project";
import updateProjectCtrl from "./controllers/update-project";
import { toPublicProject } from "./response";

const project = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
  .get(
    "/",
    describeRoute({
      operationId: "listProjects",
      tags: ["Projects"],
      description: "Get all projects in a workspace",
      responses: {
        200: {
          description: "List of projects with statistics",
          content: {
            "application/json": { schema: resolver(v.array(projectSchema)) },
          },
        },
      },
    }),
    validator(
      "query",
      v.object({
        workspaceId: v.string(),
        includeArchived: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromQuery(),
    requireWorkspacePermission({ project: ["read"] }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { includeArchived } = c.req.valid("query");
      const projects = await getProjectsCtrl(
        workspaceId,
        c.get("userId"),
        includeArchived === "true",
      );
      return c.json(projects.map((item) => toPublicProject(item)));
    },
  )
  .post(
    "/",
    describeRoute({
      operationId: "createProject",
      tags: ["Projects"],
      description: "Create a new project in a workspace",
      responses: {
        200: {
          description: "Project created successfully",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        name: v.string(),
        workspaceId: v.string(),
        icon: v.string(),
        slug: v.string(),
      }),
    ),
    workspaceAccess.fromBody(),
    requireWorkspacePermission({ project: ["create"] }),
    async (c) => {
      const { name, icon, slug } = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const newProject = await createProjectCtrl(
        workspaceId,
        name,
        icon,
        slug,
        c.get("userId"),
      );
      return c.json(toPublicProject(newProject));
    },
  )
  .get(
    "/:id",
    describeRoute({
      operationId: "getProject",
      tags: ["Projects"],
      description: "Get a specific project by ID",
      responses: {
        200: {
          description: "Project details",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["read"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const projectData = await getProjectCtrl(id, workspaceId);
      return c.json(toPublicProject(projectData));
    },
  )
  .put(
    "/reorder",
    describeRoute({
      operationId: "reorderProjects",
      tags: ["Projects"],
      description: "Reorder projects in a workspace",
      responses: {
        200: {
          description: "Projects reordered successfully",
          content: {
            "application/json": { schema: resolver(v.array(projectSchema)) },
          },
        },
      },
    }),
    validator("query", v.object({ workspaceId: v.string() })),
    validator(
      "json",
      v.object({
        // Positions express a relative order only; the controller renumbers
        // the workspace to 0..n-1, so the values just have to be sane.
        projects: v.pipe(
          v.array(
            v.object({
              id: v.string(),
              position: v.pipe(v.number(), v.integer(), v.minValue(0)),
            }),
          ),
          v.minLength(1),
        ),
      }),
    ),
    workspaceAccess.fromQuery(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { projects } = c.req.valid("json");
      const reordered = await reorderProjectsCtrl(
        workspaceId,
        c.get("userId"),
        projects,
      );
      return c.json(reordered.map((item) => toPublicProject(item)));
    },
  )
  .put(
    "/:id",
    describeRoute({
      operationId: "updateProject",
      tags: ["Projects"],
      description: "Update an existing project",
      responses: {
        200: {
          description: "Project updated successfully",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        name: v.string(),
        icon: v.string(),
        slug: v.string(),
        description: v.string(),
        isPublic: v.boolean(),
        projectGroupId: v.optional(v.nullable(v.string())),
      }),
    ),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name, icon, slug, description, isPublic, projectGroupId } =
        c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const updatedProject = await updateProjectCtrl(
        id,
        name,
        icon,
        slug,
        description,
        isPublic,
        workspaceId,
        projectGroupId,
      );
      return c.json(toPublicProject(updatedProject));
    },
  )
  .delete(
    "/:id",
    describeRoute({
      operationId: "deleteProject",
      tags: ["Projects"],
      description: "Delete a project by ID",
      responses: {
        200: {
          description: "Project deleted successfully",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["delete"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const deletedProject = await deleteProjectCtrl(id, workspaceId);
      return c.json(toPublicProject(deletedProject));
    },
  )
  .put(
    "/:id/archive",
    describeRoute({
      operationId: "archiveProject",
      tags: ["Projects"],
      description: "Archive a project by ID",
      responses: {
        200: {
          description: "Project archived successfully",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const archivedProject = await archiveProjectCtrl(id, workspaceId);
      return c.json(toPublicProject(archivedProject));
    },
  )
  .put(
    "/:id/unarchive",
    describeRoute({
      operationId: "unarchiveProject",
      tags: ["Projects"],
      description: "Unarchive a project by ID",
      responses: {
        200: {
          description: "Project unarchived successfully",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const unarchivedProject = await unarchiveProjectCtrl(id, workspaceId);
      return c.json(toPublicProject(unarchivedProject));
    },
  )
  .put(
    "/:id/move",
    describeRoute({
      operationId: "moveProject",
      tags: ["Projects"],
      description:
        "Move a project and its tasks to another workspace. Remove cross-project task relationships first.",
      responses: {
        200: {
          description: "Project moved",
          content: {
            "application/json": { schema: resolver(projectSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ workspaceId: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update", "delete"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { workspaceId: targetWorkspaceId } = c.req.valid("json");
      const sourceWorkspaceId = c.get("workspaceId");
      const userId = c.get("userId");
      await validateWorkspaceAccess(userId, targetWorkspaceId, undefined, {
        notFoundMessage: "Destination workspace not found",
      });
      if (
        !(await hasWorkspacePermission(
          c,
          { project: ["create"], workspace: ["manage_settings"] },
          targetWorkspaceId,
        ))
      ) {
        throw new HTTPException(403, {
          message: "Insufficient permissions in the target workspace",
        });
      }
      const moved = await moveProjectCtrl(
        id,
        sourceWorkspaceId,
        targetWorkspaceId,
        userId,
      );
      return c.json(toPublicProject(moved));
    },
  )
  .get(
    "/:id/background",
    describeRoute({
      operationId: "getProjectBackground",
      tags: ["Projects"],
      description: "Download the current project board background image.",
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["read"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      return getProjectBackground(id, c.req.header("If-None-Match"));
    },
  )
  .put(
    "/:id/background-upload",
    describeRoute({
      operationId: "uploadProjectBackground",
      tags: ["Projects"],
      description: "Create a presigned background image upload URL.",
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ contentType: v.string(), size: v.number() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { contentType, size } = c.req.valid("json");
      return c.json(
        await prepareProjectBackgroundUpload(id, contentType, size),
      );
    },
  )
  .post(
    "/:id/background-upload/finalize",
    describeRoute({
      operationId: "finalizeProjectBackgroundUpload",
      tags: ["Projects"],
      description: "Save an uploaded image as the project board background.",
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        key: v.string(),
        contentType: v.string(),
        version: v.string(),
        size: v.number(),
      }),
    ),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json(
        await finalizeProjectBackground({
          id,
          ...body,
          apiBaseUrl: process.env.KANEO_API_URL || new URL(c.req.url).origin,
        }),
      );
    },
  )
  .delete(
    "/:id/background",
    describeRoute({
      operationId: "deleteProjectBackground",
      tags: ["Projects"],
      description: "Remove the current project board background image.",
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      await removeProjectBackground(id);
      return c.body(null, 204);
    },
  );

export default project;
