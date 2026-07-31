import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import addUserToWorkspace from "./controllers/add-user-to-workspace";
import listInstanceUsers from "./controllers/list-instance-users";
import listInstanceWorkspaces from "./controllers/list-instance-workspaces";
import removeUserFromWorkspace from "./controllers/remove-user-from-workspace";
import updateUserStatus from "./controllers/update-user-status";
import updateUserWorkspaceRole from "./controllers/update-user-workspace-role";
import { requireInstanceAdmin } from "./middleware/require-instance-admin";

const instance = new Hono()
  .use("*", requireInstanceAdmin)
  .get(
    "/users",
    describeRoute({
      operationId: "listInstanceUsers",
      tags: ["Instance"],
      description: "List instance users",
      responses: {
        200: {
          description: "Users",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "query",
      v.object({
        limit: v.optional(
          v.pipe(
            v.string(),
            v.transform(Number),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
          ),
        ),
        offset: v.optional(
          v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0)),
        ),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      return c.json(
        await listInstanceUsers(query.limit ?? 50, query.offset ?? 0),
      );
    },
  )
  .get(
    "/workspaces",
    describeRoute({
      operationId: "listInstanceWorkspaces",
      tags: ["Instance"],
      description: "List instance workspaces",
      responses: {
        200: {
          description: "Workspaces",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    async (c) => c.json(await listInstanceWorkspaces()),
  )
  .post(
    "/users/:userId/workspaces",
    describeRoute({
      operationId: "addUserToWorkspace",
      tags: ["Instance"],
      description: "Add a user to a workspace",
      responses: {
        201: {
          description: "Membership",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ userId: v.string() })),
    validator("json", v.object({ workspaceId: v.string(), role: v.string() })),
    async (c) => {
      const { userId } = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json(
        await addUserToWorkspace(userId, body.workspaceId, body.role),
        201,
      );
    },
  )
  .patch(
    "/users/:userId/workspaces/:workspaceId",
    describeRoute({
      operationId: "updateUserWorkspaceRole",
      tags: ["Instance"],
      description: "Update a user's workspace role",
      responses: {
        200: {
          description: "Membership",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "param",
      v.object({ userId: v.string(), workspaceId: v.string() }),
    ),
    validator("json", v.object({ role: v.string() })),
    async (c) => {
      const params = c.req.valid("param");
      const { role } = c.req.valid("json");
      return c.json(
        await updateUserWorkspaceRole(params.userId, params.workspaceId, role),
      );
    },
  )
  .delete(
    "/users/:userId/workspaces/:workspaceId",
    describeRoute({
      operationId: "removeUserFromWorkspace",
      tags: ["Instance"],
      description: "Remove a user from a workspace",
      responses: { 204: { description: "Membership removed" } },
    }),
    validator(
      "param",
      v.object({ userId: v.string(), workspaceId: v.string() }),
    ),
    async (c) => {
      const params = c.req.valid("param");
      await removeUserFromWorkspace(params.userId, params.workspaceId);
      return c.body(null, 204);
    },
  )
  .patch(
    "/users/:userId/status",
    describeRoute({
      operationId: "updateUserStatus",
      tags: ["Instance"],
      description: "Ban or unban an instance user",
      responses: {
        200: {
          description: "Updated user",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ userId: v.string() })),
    validator(
      "json",
      v.object({
        banned: v.boolean(),
        banReason: v.optional(v.nullable(v.string())),
        banExpires: v.optional(v.nullable(v.string())),
      }),
    ),
    async (c) => {
      const { userId } = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json(
        await updateUserStatus(
          userId,
          c.get("userId"),
          body.banned,
          body.banReason,
          body.banExpires,
        ),
      );
    },
  );

export default instance;
