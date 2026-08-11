import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("workspace member offboarding", () => {
  beforeEach(resetTestDatabase);

  it("clears only that workspace's assignments on a raw membership delete", async () => {
    const first = await createWorkspaceMember();
    const second = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: second.workspace.id,
      userId: first.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const firstProject = await createProjectFixture({
      workspaceId: first.workspace.id,
    });
    const secondProject = await createProjectFixture({
      workspaceId: second.workspace.id,
    });
    const [firstTask, secondTask] = await db
      .insert(schema.taskTable)
      .values([
        {
          projectId: firstProject.project.id,
          title: "Keep",
          status: "to-do",
          number: 1,
          userId: first.user.id,
        },
        {
          projectId: secondProject.project.id,
          title: "Clear",
          status: "to-do",
          number: 1,
          userId: first.user.id,
        },
      ])
      .returning();
    if (!firstTask || !secondTask) throw new Error("Failed to create tasks");

    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, second.workspace.id),
          eq(schema.workspaceUserTable.userId, first.user.id),
        ),
      );

    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, firstTask.id),
      }),
    ).resolves.toMatchObject({ userId: first.user.id });
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, secondTask.id),
      }),
    ).resolves.toMatchObject({ userId: null });
  });

  it("atomically clears workspace assignments and hides legacy stale assignments", async () => {
    const adminContext = await createWorkspaceMember({ role: "admin" });
    const [instanceAdmin] = await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, adminContext.user.id))
      .returning();
    if (!instanceAdmin) throw new Error("Failed to promote instance admin");
    const member = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: adminContext.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const removedProject = await createProjectFixture({
      workspaceId: adminContext.workspace.id,
    });
    const retainedProject = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [removedTask, retainedTask] = await db
      .insert(schema.taskTable)
      .values([
        {
          projectId: removedProject.project.id,
          title: "Former workspace task",
          status: "to-do",
          number: 1,
          userId: member.user.id,
        },
        {
          projectId: retainedProject.project.id,
          title: "Retained workspace task",
          status: "to-do",
          number: 1,
          userId: member.user.id,
        },
      ])
      .returning();
    if (!removedTask || !retainedTask)
      throw new Error("Failed to create tasks");

    mockAuthenticatedSession(member.user);
    const memberApp = createApp().app;
    const before = await memberApp.request("/api/task/my");
    expect(before.status).toBe(200);
    expect((await before.json()).tasks).toHaveLength(2);

    mockAuthenticatedSession(instanceAdmin);
    const adminApp = createApp().app;
    const removal = await adminApp.request(
      `/api/instance/users/${member.user.id}/workspaces/${adminContext.workspace.id}`,
      { method: "DELETE" },
    );
    expect(removal.status).toBe(204);

    mockAuthenticatedSession(member.user);
    const after = await createApp().app.request("/api/task/my");
    expect(after.status).toBe(200);
    expect((await after.json()).tasks).toEqual([
      expect.objectContaining({ id: retainedTask.id }),
    ]);
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, removedTask.id),
      }),
    ).resolves.toMatchObject({ userId: null });
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, retainedTask.id),
      }),
    ).resolves.toMatchObject({ userId: member.user.id });

    await db
      .update(schema.taskTable)
      .set({ userId: member.user.id })
      .where(eq(schema.taskTable.id, removedTask.id));
    const legacy = await createApp().app.request("/api/task/my");
    expect((await legacy.json()).tasks).toEqual([
      expect.objectContaining({ id: retainedTask.id }),
    ]);
    await expect(
      db.query.workspaceUserTable.findFirst({
        where: and(
          eq(schema.workspaceUserTable.userId, member.user.id),
          eq(schema.workspaceUserTable.workspaceId, adminContext.workspace.id),
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("cannot recreate an assignment racing with offboarding", async () => {
    const adminContext = await createWorkspaceMember({ role: "admin" });
    const [instanceAdmin] = await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, adminContext.user.id))
      .returning();
    if (!instanceAdmin) throw new Error("Failed to promote instance admin");
    const member = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: adminContext.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: adminContext.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Race",
        status: "to-do",
        number: 1,
      })
      .returning();
    if (!task) throw new Error("Failed to create task");

    const blocker = await getDatabasePool().connect();
    const lockKey = `${adminContext.workspace.id}:${member.user.id}`;
    await blocker.query("SELECT pg_advisory_lock(1530, hashtext($1))", [
      lockKey,
    ]);
    mockAuthenticatedSession(instanceAdmin);
    const app = createApp().app;
    const assignment = app.request(`/api/task/assignee/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: member.user.id }),
    });
    const removal = app.request(
      `/api/instance/users/${member.user.id}/workspaces/${adminContext.workspace.id}`,
      { method: "DELETE" },
    );
    await blocker.query("SELECT pg_advisory_unlock(1530, hashtext($1))", [
      lockKey,
    ]);
    blocker.release();

    const [assignmentResponse, removalResponse] = await Promise.all([
      assignment,
      removal,
    ]);
    expect([200, 404]).toContain(assignmentResponse.status);
    expect(removalResponse.status).toBe(204);
    await expect(
      db.query.taskTable.findFirst({ where: eq(schema.taskTable.id, task.id) }),
    ).resolves.toMatchObject({ userId: null });
  });
});
