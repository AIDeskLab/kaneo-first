import { and, eq, isNotNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import deleteLabel from "../../apps/api/src/label/controllers/delete-label";
import { normalizeLabelIdentity } from "../../apps/api/src/label/controllers/workspace-label-lock";
import bulkUpdateTasks from "../../apps/api/src/task/controllers/bulk-update-tasks";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const WORKSPACE_LABEL_LOCK_NAMESPACE = 1533;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitForBlockedLabelMutations(minWaiters: number) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await getDatabasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = $1
         AND NOT granted`,
      [WORKSPACE_LABEL_LOCK_NAMESPACE],
    );

    if (Number(result.rows[0]?.count) >= minWaiters) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(
    `Label mutations did not reach ${minWaiters} blocked waiters on the advisory lock`,
  );
}

describe("bulk add label concurrency", () => {
  it("does not resurrect a deleted workspace definition under lock contention", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Bulk label target",
        status: "to-do",
        columnId: columns.todo.id,
        number: 1,
        position: 1,
      })
      .returning();
    const [workspaceLabel] = await db
      .insert(schema.labelTable)
      .values({
        name: "race-label",
        color: "#ef4444",
        workspaceId: member.workspace.id,
        taskId: null,
      })
      .returning();
    if (!task || !workspaceLabel) throw new Error("Failed to seed fixtures");

    const lockKey = `${member.workspace.id}:${normalizeLabelIdentity(workspaceLabel.name)}`;
    const blocker = await getDatabasePool().connect();
    let lockHeld = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_LABEL_LOCK_NAMESPACE,
        lockKey,
      ]);
      lockHeld = true;

      const deletion = deleteLabel(workspaceLabel.id, member.user.id);
      await waitForBlockedLabelMutations(1);

      const bulkAdd = bulkUpdateTasks({
        taskIds: [task.id],
        operation: "addLabel",
        value: workspaceLabel.id,
        userId: member.user.id,
      });
      await waitForBlockedLabelMutations(2);

      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_LABEL_LOCK_NAMESPACE,
        lockKey,
      ]);
      lockHeld = false;

      const results = await withTimeout(
        Promise.allSettled([deletion, bulkAdd]),
        10_000,
      );
      const [deleteResult, bulkResult] = results;
      expect(deleteResult?.status).toBe("fulfilled");
      expect(bulkResult?.status).toBe("rejected");
      if (bulkResult?.status === "rejected") {
        expect(bulkResult.reason).toMatchObject({ status: 404 });
      }

      const taskLabels = await db.query.labelTable.findMany({
        where: and(
          eq(schema.labelTable.workspaceId, member.workspace.id),
          eq(schema.labelTable.name, workspaceLabel.name),
          isNotNull(schema.labelTable.taskId),
        ),
      });
      expect(taskLabels).toHaveLength(0);
      await expect(
        db.query.labelTable.findFirst({
          where: eq(schema.labelTable.id, workspaceLabel.id),
        }),
      ).resolves.toBeUndefined();
    } finally {
      if (lockHeld) {
        await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          WORKSPACE_LABEL_LOCK_NAMESPACE,
          lockKey,
        ]);
      }
      blocker.release();
    }
  }, 20_000);
});
