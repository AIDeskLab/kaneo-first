import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("task date invariant under concurrency", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a due-date write racing with a later start-date write", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const taskId = `task-${randomUUID()}`;

    await db.insert(schema.taskTable).values({
      id: taskId,
      projectId: project.id,
      title: "Concurrent dates",
      status: "to-do",
      startDate: new Date("2026-04-01T09:00:00.000Z"),
      dueDate: new Date("2026-04-10T09:00:00.000Z"),
    });

    // biome-ignore lint/suspicious/noUndeclaredEnvVars: integration setup requires this database URL.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL must be defined");
    const startDateWriter = new Client({ connectionString: databaseUrl });
    const dueDateWriter = new Client({
      connectionString: databaseUrl,
    });
    await Promise.all([startDateWriter.connect(), dueDateWriter.connect()]);

    try {
      await startDateWriter.query("BEGIN");
      await dueDateWriter.query("BEGIN");
      await startDateWriter.query(
        'UPDATE "task" SET "start_date" = $1 WHERE "id" = $2',
        ["2026-04-08T09:00:00.000Z", taskId],
      );

      const conflictingWrite = dueDateWriter.query(
        'UPDATE "task" SET "due_date" = $1 WHERE "id" = $2',
        ["2026-04-05T09:00:00.000Z", taskId],
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await startDateWriter.query("COMMIT");

      await expect(conflictingWrite).rejects.toMatchObject({
        code: "23514",
        constraint: "task_start_date_before_due_date_check",
      });
      await dueDateWriter.query("ROLLBACK");

      const persisted = await db.query.taskTable.findFirst({
        where: (task, { eq }) => eq(task.id, taskId),
      });
      expect(persisted?.startDate?.toISOString()).toBe(
        "2026-04-08T09:00:00.000Z",
      );
      expect(persisted?.dueDate?.toISOString()).toBe(
        "2026-04-10T09:00:00.000Z",
      );
    } finally {
      await Promise.allSettled([
        startDateWriter.query("ROLLBACK"),
        dueDateWriter.query("ROLLBACK"),
      ]);
      await Promise.all([startDateWriter.end(), dueDateWriter.end()]);
    }
  });
});
