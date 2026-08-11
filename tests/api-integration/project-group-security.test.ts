import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("project group workspace isolation", () => {
  beforeEach(resetTestDatabase);

  it("denies update and delete from a foreign workspace", async () => {
    const actor = await createWorkspaceMember();
    const foreign = await createWorkspaceMember();
    const [group] = await db
      .insert(schema.projectGroupTable)
      .values({ workspaceId: foreign.workspace.id, name: "Foreign" })
      .returning();
    if (!group) throw new Error("Failed to create group");
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();

    const update = await app.request(`/api/project-group/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Stolen" }),
    });
    const remove = await app.request(`/api/project-group/${group.id}`, {
      method: "DELETE",
    });

    expect(update.status).toBe(403);
    expect(remove.status).toBe(403);
    await expect(
      db.query.projectGroupTable.findFirst({
        where: eq(schema.projectGroupTable.id, group.id),
      }),
    ).resolves.toMatchObject({ name: "Foreign" });
  });

  it("allows same-workspace update and delete", async () => {
    const actor = await createWorkspaceMember();
    const [group] = await db
      .insert(schema.projectGroupTable)
      .values({ workspaceId: actor.workspace.id, name: "Original" })
      .returning();
    if (!group) throw new Error("Failed to create group");
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();

    const update = await app.request(`/api/project-group/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ name: "Updated" });

    const remove = await app.request(`/api/project-group/${group.id}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    await expect(
      db.query.projectGroupTable.findFirst({
        where: eq(schema.projectGroupTable.id, group.id),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects missing and cross-workspace project groups without mutation", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const foreign = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    const [foreignGroup] = await db
      .insert(schema.projectGroupTable)
      .values({ workspaceId: foreign.workspace.id, name: "Foreign" })
      .returning();
    if (!foreignGroup) throw new Error("Failed to create group");
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();
    const updateBody = (projectGroupId: string) => ({
      name: "Mutated",
      icon: project.icon ?? "Folder",
      slug: project.slug,
      description: "changed",
      isPublic: true,
      projectGroupId,
    });

    for (const groupId of [foreignGroup.id, "missing-group"]) {
      const response = await app.request(`/api/project/${project.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updateBody(groupId)),
      });
      expect(response.status).toBe(404);
    }
    await expect(
      db.query.projectTable.findFirst({
        where: and(
          eq(schema.projectTable.id, project.id),
          eq(schema.projectTable.workspaceId, actor.workspace.id),
        ),
      }),
    ).resolves.toMatchObject({
      name: project.name,
      description: project.description,
      isPublic: project.isPublic,
      projectGroupId: null,
    });

    const [localGroup] = await db
      .insert(schema.projectGroupTable)
      .values({ workspaceId: actor.workspace.id, name: "Local" })
      .returning();
    if (!localGroup) throw new Error("Failed to create local group");
    const allowed = await app.request(`/api/project/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updateBody(localGroup.id)),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      projectGroupId: localGroup.id,
    });
  });
});
