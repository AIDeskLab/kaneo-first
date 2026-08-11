import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { importLabelsForTask } from "../../apps/api/src/gitea-integration/controllers/import-gitea-issues";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Gitea label import", () => {
  it("does not invent provenance for legacy labels on Gitea-linked tasks", async () => {
    await resetTestDatabase();
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const [giteaTask] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Gitea",
        status: "to-do",
        number: 1,
      })
      .returning();
    if (!giteaTask) throw new Error("Failed to create task");
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({ projectId: project.id, type: "gitea", config: "{}" })
      .returning();
    if (!integration) throw new Error("Failed to create integration");
    await db.insert(schema.externalLinkTable).values({
      taskId: giteaTask.id,
      integrationId: integration.id,
      resourceType: "issue",
      externalId: "1",
      url: "https://gitea.example/issues/1",
    });
    await db.insert(schema.labelTable).values([
      {
        workspaceId: workspace.id,
        taskId: giteaTask.id,
        name: "Legacy local",
        color: "#111111",
      },
      {
        workspaceId: workspace.id,
        taskId: giteaTask.id,
        name: "Known provider",
        color: "#222222",
        source: "gitea",
      },
    ]);

    const migration = await readFile(
      new URL(
        "../../apps/api/drizzle/0038_silky_lethal_legion.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).not.toMatch(/UPDATE\s+"label"/i);

    await importLabelsForTask([], giteaTask.id, workspace.id, async () => []);
    await expect(
      db.query.labelTable.findMany({
        where: eq(schema.labelTable.taskId, giteaTask.id),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ name: "Legacy local", source: "local" }),
    ]);
  });

  it("removes only Gitea-owned labels that disappeared externally", async () => {
    await resetTestDatabase();
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Imported issue",
        description: "",
        status: "to-do",
        priority: "medium",
        number: 1,
      })
      .returning();
    if (!task) throw new Error("Task fixture was not created");

    await db.insert(schema.labelTable).values({
      workspaceId: workspace.id,
      taskId: task.id,
      name: "stale",
      color: "#000000",
    });

    await db.insert(schema.labelTable).values({
      workspaceId: workspace.id,
      taskId: task.id,
      name: "gitea-stale",
      color: "#111111",
      source: "gitea",
    });

    const currentLabels = [{ id: 1, name: "current", color: "ff0000" }];
    await importLabelsForTask(
      currentLabels,
      task.id,
      workspace.id,
      async () => currentLabels,
    );

    await expect(
      db.query.labelTable.findMany({
        where: eq(schema.labelTable.taskId, task.id),
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "stale", source: "local" }),
        expect.objectContaining({ name: "current", source: "gitea" }),
      ]),
    );

    await importLabelsForTask([], task.id, workspace.id, async () => []);
    await expect(
      db.query.labelTable.findMany({
        where: eq(schema.labelTable.taskId, task.id),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ name: "stale", source: "local" }),
    ]);
  });

  it("keeps a matching pre-existing local assignment locally owned", async () => {
    await resetTestDatabase();
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Imported issue",
        status: "to-do",
        number: 1,
      })
      .returning();
    if (!task) throw new Error("Task fixture was not created");
    await db.insert(schema.labelTable).values({
      workspaceId: workspace.id,
      taskId: task.id,
      name: "shared",
      color: "#123456",
    });

    const sharedLabels = [{ id: 1, name: "shared", color: "ffffff" }];
    await importLabelsForTask(
      sharedLabels,
      task.id,
      workspace.id,
      async () => sharedLabels,
    );
    await importLabelsForTask([], task.id, workspace.id, async () => []);

    await expect(
      db.query.labelTable.findFirst({
        where: eq(schema.labelTable.taskId, task.id),
      }),
    ).resolves.toMatchObject({
      name: "shared",
      color: "#123456",
      source: "local",
    });
  });

  it("rolls back stale removal when a replacement insert fails", async () => {
    await resetTestDatabase();
    const { workspace } = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Atomic import",
        status: "to-do",
        number: 1,
      })
      .returning();
    if (!task) throw new Error("Task fixture was not created");
    await db.insert(schema.labelTable).values({
      workspaceId: workspace.id,
      taskId: task.id,
      name: "old-external",
      color: "#000000",
      source: "gitea",
    });

    await db.execute(
      sql.raw(`
      CREATE FUNCTION kdl111_reject_label() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'reject-me' THEN RAISE EXCEPTION 'test rejection'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER kdl111_reject_label BEFORE INSERT ON label
      FOR EACH ROW EXECUTE FUNCTION kdl111_reject_label();
    `),
    );
    try {
      const rejectLabels = [{ id: 2, name: "reject-me", color: "ffffff" }];
      await expect(
        importLabelsForTask(
          rejectLabels,
          task.id,
          workspace.id,
          async () => rejectLabels,
        ),
      ).rejects.toThrow();
      await expect(
        db.query.labelTable.findFirst({
          where: eq(schema.labelTable.taskId, task.id),
        }),
      ).resolves.toMatchObject({ name: "old-external", source: "gitea" });
    } finally {
      await db.execute(
        sql.raw(`
        DROP TRIGGER IF EXISTS kdl111_reject_label ON label;
        DROP FUNCTION IF EXISTS kdl111_reject_label();
      `),
      );
    }
  });
});
