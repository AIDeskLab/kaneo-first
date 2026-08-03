import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

async function createUser(name = "Instance Test User") {
  const id = `user-${randomUUID()}`;
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id,
      email: `${id}@example.com`,
      emailVerified: true,
      name,
    })
    .returning();
  return user;
}

async function createInstanceAdmin() {
  const member = await createWorkspaceMember();
  const [admin] = await db
    .update(schema.userTable)
    .set({ role: "admin" })
    .where(eq(schema.userTable.id, member.user.id))
    .returning();
  return { admin, workspace: member.workspace };
}

function jsonRequest(
  app: ReturnType<typeof createApp>["app"],
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectInstanceForbidden(
  app: ReturnType<typeof createApp>["app"],
  userId: string,
  workspaceId: string,
) {
  const responses = await Promise.all([
    app.request("/api/instance/users"),
    app.request("/api/instance/workspaces"),
    jsonRequest(app, `/api/instance/users/${userId}/workspaces`, "POST", {
      workspaceId,
      role: "member",
    }),
    jsonRequest(
      app,
      `/api/instance/users/${userId}/workspaces/${workspaceId}`,
      "PATCH",
      { role: "admin" },
    ),
    app.request(`/api/instance/users/${userId}/workspaces/${workspaceId}`, {
      method: "DELETE",
    }),
    jsonRequest(app, `/api/instance/users/${userId}/status`, "PATCH", {
      banned: false,
    }),
  ]);

  for (const response of responses) {
    expect(response.status).toBe(403);
  }
}

describe("API integration: instance user management", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("lists users with memberships, roles, and total", async () => {
    const { admin, workspace } = await createInstanceAdmin();
    const target = await createWorkspaceMember({
      workspaceName: "Second Workspace",
      role: "viewer",
    });

    mockAuthenticatedSession(admin);
    const { app } = createApp();
    const response = await app.request("/api/instance/users");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      limit: 50,
      offset: 0,
      users: expect.arrayContaining([
        expect.objectContaining({
          id: admin.id,
          workspaces: [
            expect.objectContaining({ id: workspace.id, role: "member" }),
          ],
        }),
        expect.objectContaining({
          id: target.user.id,
          workspaces: [
            expect.objectContaining({
              id: target.workspace.id,
              role: "viewer",
            }),
          ],
        }),
      ]),
    });
  });

  it("supports user list pagination while preserving total", async () => {
    const { admin } = await createInstanceAdmin();
    await createUser("Second User");
    await createUser("Third User");

    mockAuthenticatedSession(admin);
    const { app } = createApp();
    const response = await app.request("/api/instance/users?limit=1&offset=1");

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      total: 3,
      limit: 1,
      offset: 1,
      users: expect.any(Array),
    });
  });

  it("lists all workspaces and their built-in and custom roles", async () => {
    const { admin, workspace } = await createInstanceAdmin();
    const second = await createWorkspaceMember({
      workspaceName: "Custom Roles Workspace",
    });
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: second.workspace.id,
      role: "auditor",
      permission: JSON.stringify({ task: ["read"] }),
    });

    mockAuthenticatedSession(admin);
    const { app } = createApp();
    const response = await app.request("/api/instance/workspaces");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workspace.id,
          roles: expect.arrayContaining([
            expect.objectContaining({ name: "member", isBuiltIn: true }),
          ]),
        }),
        expect.objectContaining({
          id: second.workspace.id,
          roles: expect.arrayContaining([
            expect.objectContaining({ name: "auditor", isBuiltIn: false }),
          ]),
        }),
      ]),
    );
  });

  it("adds a membership and rejects duplicate membership", async () => {
    const { admin, workspace } = await createInstanceAdmin();
    const target = await createUser("Target User");
    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const response = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/workspaces`,
      "POST",
      { workspaceId: workspace.id, role: "member" },
    );
    expect(response.status).toBe(201);

    const persisted = await db.query.workspaceUserTable.findFirst({
      where: and(
        eq(schema.workspaceUserTable.userId, target.id),
        eq(schema.workspaceUserTable.workspaceId, workspace.id),
      ),
    });
    expect(persisted?.role).toBe("member");

    const duplicate = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/workspaces`,
      "POST",
      { workspaceId: workspace.id, role: "member" },
    );
    expect(duplicate.status).toBe(409);
  });

  it("updates and removes a membership without deleting the user", async () => {
    const { admin } = await createInstanceAdmin();
    const target = await createWorkspaceMember({ role: "member" });
    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const update = await jsonRequest(
      app,
      `/api/instance/users/${target.user.id}/workspaces/${target.workspace.id}`,
      "PATCH",
      { role: "admin" },
    );
    expect(update.status).toBe(200);

    const updated = await db.query.workspaceUserTable.findFirst({
      where: eq(schema.workspaceUserTable.userId, target.user.id),
    });
    expect(updated?.role).toBe("admin");

    const remove = await app.request(
      `/api/instance/users/${target.user.id}/workspaces/${target.workspace.id}`,
      { method: "DELETE" },
    );
    expect([200, 204]).toContain(remove.status);

    const membership = await db.query.workspaceUserTable.findFirst({
      where: and(
        eq(schema.workspaceUserTable.userId, target.user.id),
        eq(schema.workspaceUserTable.workspaceId, target.workspace.id),
      ),
    });
    expect(membership).toBeUndefined();
    const user = await db.query.userTable.findFirst({
      where: eq(schema.userTable.id, target.user.id),
    });
    expect(user).toBeDefined();
  });

  it("bans and unbans a user, clearing ban fields on unban", async () => {
    const { admin } = await createInstanceAdmin();
    const target = await createUser("Bannable User");
    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const ban = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/status`,
      "PATCH",
      {
        banned: true,
        banReason: "Integration test",
        banExpires: "2030-01-01T00:00:00.000Z",
      },
    );
    expect(ban.status).toBe(200);

    const banned = await db.query.userTable.findFirst({
      where: eq(schema.userTable.id, target.id),
    });
    expect(banned).toMatchObject({
      banned: true,
      banReason: "Integration test",
    });
    expect(banned?.banExpires).toBeInstanceOf(Date);

    const unban = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/status`,
      "PATCH",
      { banned: false },
    );
    expect(unban.status).toBe(200);

    const unbanned = await db.query.userTable.findFirst({
      where: eq(schema.userTable.id, target.id),
    });
    expect(unbanned).toMatchObject({
      banned: false,
      banReason: null,
      banExpires: null,
    });
  });

  it("returns 403 for regular and workspace-admin users", async () => {
    const regular = await createWorkspaceMember({ role: "member" });
    mockAuthenticatedSession(regular.user);
    const regularApp = createApp().app;
    await expectInstanceForbidden(
      regularApp,
      regular.user.id,
      regular.workspace.id,
    );

    const workspaceAdmin = await createWorkspaceMember({ role: "admin" });
    mockAuthenticatedSession(workspaceAdmin.user);
    const workspaceAdminApp = createApp().app;
    await expectInstanceForbidden(
      workspaceAdminApp,
      workspaceAdmin.user.id,
      workspaceAdmin.workspace.id,
    );
  });

  it("returns 401 for unauthenticated requests to every instance endpoint", async () => {
    const user = await createUser();
    const workspace = await createWorkspaceMember();
    mockAnonymousSession();
    const { app } = createApp();

    const responses = await Promise.all([
      app.request("/api/instance/users"),
      app.request("/api/instance/workspaces"),
      jsonRequest(app, `/api/instance/users/${user.id}/workspaces`, "POST", {
        workspaceId: workspace.workspace.id,
        role: "member",
      }),
      jsonRequest(
        app,
        `/api/instance/users/${user.id}/workspaces/${workspace.workspace.id}`,
        "PATCH",
        { role: "member" },
      ),
      app.request(
        `/api/instance/users/${user.id}/workspaces/${workspace.workspace.id}`,
        { method: "DELETE" },
      ),
      jsonRequest(app, `/api/instance/users/${user.id}/status`, "PATCH", {
        banned: false,
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
    }
  });

  it("returns 404 for unknown users, workspaces, and memberships", async () => {
    const { admin, workspace } = await createInstanceAdmin();
    const target = await createUser();
    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const unknownUser = await jsonRequest(
      app,
      "/api/instance/users/unknown-user/workspaces",
      "POST",
      { workspaceId: workspace.id, role: "member" },
    );
    expect(unknownUser.status).toBe(404);

    const unknownWorkspace = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/workspaces`,
      "POST",
      { workspaceId: "unknown-workspace", role: "member" },
    );
    expect(unknownWorkspace.status).toBe(404);

    const unknownMembership = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/workspaces/${workspace.id}`,
      "PATCH",
      { role: "admin" },
    );
    expect(unknownMembership.status).toBe(404);

    const unknownDelete = await app.request(
      `/api/instance/users/${target.id}/workspaces/${workspace.id}`,
      { method: "DELETE" },
    );
    expect(unknownDelete.status).toBe(404);

    const unknownStatusUser = await jsonRequest(
      app,
      "/api/instance/users/unknown-user/status",
      "PATCH",
      { banned: true },
    );
    expect(unknownStatusUser.status).toBe(404);
  });

  it("accepts workspace custom roles and rejects unknown roles", async () => {
    const { admin, workspace } = await createInstanceAdmin();
    const customRole = "auditor";
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: customRole,
      permission: JSON.stringify({ task: ["read"] }),
    });
    const target = await createUser();
    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const customRoleResponse = await jsonRequest(
      app,
      `/api/instance/users/${target.id}/workspaces`,
      "POST",
      { workspaceId: workspace.id, role: customRole },
    );
    expect(customRoleResponse.status).toBe(201);

    const anotherTarget = await createUser("Another Target");
    const invalidRoleResponse = await jsonRequest(
      app,
      `/api/instance/users/${anotherTarget.id}/workspaces`,
      "POST",
      { workspaceId: workspace.id, role: "does-not-exist" },
    );
    expect([400, 422]).toContain(invalidRoleResponse.status);
  });

  it("accepts limit=1000 (regression guard for #13) and rejects limit>1000", async () => {
    const { admin } = await createInstanceAdmin();
    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const okResponse = await app.request("/api/instance/users?limit=1000");
    expect(okResponse.status).toBe(200);

    const tooBig = await app.request("/api/instance/users?limit=1001");
    expect(tooBig.status).toBe(400);
  });
});
