import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import createProjectGroupCtrl from "./controllers/create-project-group";
import deleteProjectGroupCtrl from "./controllers/delete-project-group";
import listProjectGroupsCtrl from "./controllers/list-project-groups";
import updateProjectGroupCtrl from "./controllers/update-project-group";

const projectGroup = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
  .get(
    "/",
    describeRoute({
      operationId: "listProjectGroups",
      tags: ["Project Groups"],
      description: "Get all project groups in a workspace",
      responses: {
        200: {
          description: "List of project groups",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    id: v.string(),
                    name: v.string(),
                    workspaceId: v.string(),
                    createdAt: v.string(),
                    updatedAt: v.string(),
                  }),
                ),
              ),
            },
          },
        },
      },
    }),
    validator("query", v.object({ workspaceId: v.string() })),
    workspaceAccess.fromQuery(),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const groups = await listProjectGroupsCtrl(workspaceId);
      return c.json(groups);
    },
  )
  .post(
    "/",
    describeRoute({
      operationId: "createProjectGroup",
      tags: ["Project Groups"],
      description: "Create a project group",
      responses: {
        201: {
          description: "Created project group",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  name: v.string(),
                  workspaceId: v.string(),
                  createdAt: v.string(),
                  updatedAt: v.string(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("query", v.object({ workspaceId: v.string() })),
    validator("json", v.object({ name: v.string() })),
    workspaceAccess.fromQuery(),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { name } = c.req.valid("json");
      const group = await createProjectGroupCtrl(workspaceId, name);
      return c.json(group, 201);
    },
  )
  .patch(
    "/:id",
    describeRoute({
      operationId: "updateProjectGroup",
      tags: ["Project Groups"],
      description: "Update a project group",
      responses: {
        200: {
          description: "Updated project group",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  name: v.string(),
                  workspaceId: v.string(),
                  createdAt: v.string(),
                  updatedAt: v.string(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ name: v.string() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      const group = await updateProjectGroupCtrl(id, name);
      return c.json(group);
    },
  )
  .delete(
    "/:id",
    describeRoute({
      operationId: "deleteProjectGroup",
      tags: ["Project Groups"],
      description: "Delete a project group",
      responses: {
        200: {
          description: "Deleted project group",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  name: v.string(),
                  workspaceId: v.string(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const group = await deleteProjectGroupCtrl(id);
      return c.json(group);
    },
  );

export default projectGroup;
