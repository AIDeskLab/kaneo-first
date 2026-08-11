import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import updateTask from "../../apps/api/src/task/controllers/update-task";
import updateTaskAssignee from "../../apps/api/src/task/controllers/update-task-assignee";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const assignedTask = (userId: string) => ({
  title: "Assigned task",
  description: "Authorization regression",
  priority: "medium",
  status: "to-do",
  userId,
});

describe("task assignment authorization", () => {
  it("requires task:assign for create and import payloads with assignees", async () => {
    await resetTestDatabase();
    const actor = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    const assigneeId = `user-${randomUUID()}`;
    await db.insert(schema.userTable).values({
      id: assigneeId,
      email: `${assigneeId}@example.com`,
      emailVerified: true,
      name: "Workspace Assignee",
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: actor.workspace.id,
      userId: assigneeId,
      role: "member",
      joinedAt: new Date(),
    });

    mockAuthenticatedSession(actor.user);
    const { app } = createApp();
    const createResponse = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(assignedTask(assigneeId)),
    });
    expect(createResponse.status).toBe(403);

    const importResponse = await app.request(`/api/task/import/${project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks: [assignedTask(assigneeId)] }),
    });
    expect(importResponse.status).toBe(403);
  });

  it("rejects assignment to a user outside the project workspace", async () => {
    await resetTestDatabase();
    const actor = await createWorkspaceMember({ role: "admin" });
    const outsider = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });

    mockAuthenticatedSession(actor.user);
    const { app } = createApp();
    const createResponse = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(assignedTask(outsider.user.id)),
    });
    expect(createResponse.status).toBe(404);
    await expect(createResponse.text()).resolves.toContain(
      "Assignee not found",
    );

    const importResponse = await app.request(`/api/task/import/${project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks: [assignedTask(outsider.user.id)] }),
    });
    expect(importResponse.status).toBe(404);
    await expect(importResponse.text()).resolves.toContain(
      "Assignee not found",
    );

    const unassignedResponse = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...assignedTask(""),
        title: "Unassigned security fixture",
      }),
    });
    expect(unassignedResponse.status).toBe(200);
    const task = (await unassignedResponse.json()) as { id: string };

    const dedicatedResponse = await app.request(
      `/api/task/assignee/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: outsider.user.id }),
      },
    );
    expect(dedicatedResponse.status).toBe(404);

    const fullUpdateResponse = await app.request(`/api/task/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...assignedTask(outsider.user.id),
        projectId: project.id,
        position: 1,
      }),
    });
    expect(fullUpdateResponse.status).toBe(404);

    const bulkResponse = await app.request("/api/task/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskIds: [task.id],
        operation: "updateAssignee",
        value: outsider.user.id,
      }),
    });
    expect(bulkResponse.status).toBe(404);
  });

  it("does not let an update-only decision restore a concurrently changed assignee", async () => {
    await resetTestDatabase();
    const actor = await createWorkspaceMember({ role: "admin" });
    const second = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: actor.workspace.id,
      userId: second.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Original",
        description: "Original",
        status: "to-do",
        priority: "medium",
        position: 1,
        number: 1,
        userId: actor.user.id,
      })
      .returning();
    if (!task) throw new Error("Failed to create task");

    const blocker = await getDatabasePool().connect();
    const lockKey = `${actor.workspace.id}:${actor.user.id}`;
    await blocker.query("SELECT pg_advisory_lock(1530, hashtext($1))", [
      lockKey,
    ]);
    const staleUpdate = updateTask(
      task.id,
      "Updated title",
      task.status,
      undefined,
      undefined,
      project.id,
      task.description,
      task.priority,
      task.position,
      actor.user.id,
      actor.user.id,
      { userId: actor.user.id },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await updateTaskAssignee({
      id: task.id,
      userId: second.user.id,
      currentUserId: actor.user.id,
    });
    await blocker.query("SELECT pg_advisory_unlock(1530, hashtext($1))", [
      lockKey,
    ]);
    blocker.release();

    await expect(staleUpdate).rejects.toMatchObject({ status: 409 });
    await expect(
      db.query.taskTable.findFirst({ where: eq(schema.taskTable.id, task.id) }),
    ).resolves.toMatchObject({ userId: second.user.id, title: "Original" });
  });
});
