import { and, eq, or } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE } from "../../apps/api/src/task/controllers/task-cascade";
import createTaskRelation from "../../apps/api/src/task-relation/controllers/create-task-relation";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

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

async function waitForBlockedHierarchyMutations(minWaiters = 2) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await getDatabasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = $1
         AND NOT granted`,
      [WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE],
    );

    if (Number(result.rows[0]?.count) >= minWaiters) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(
    `Hierarchy mutations did not reach ${minWaiters} blocked waiters on the advisory lock`,
  );
}

async function insertTask({
  projectId,
  title,
  number,
  columnId,
}: {
  projectId: string;
  title: string;
  number: number;
  columnId: string;
}) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      status: "to-do",
      columnId,
      priority: "medium",
      number,
      position: number,
    })
    .returning();
  if (!task) throw new Error(`Failed to create task ${title}`);
  return task;
}

async function countSubtaskEdges(leftId: string, rightId: string) {
  const rows = await db
    .select({ id: schema.taskRelationTable.id })
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.relationType, "subtask"),
        or(
          and(
            eq(schema.taskRelationTable.sourceTaskId, leftId),
            eq(schema.taskRelationTable.targetTaskId, rightId),
          ),
          and(
            eq(schema.taskRelationTable.sourceTaskId, rightId),
            eq(schema.taskRelationTable.targetTaskId, leftId),
          ),
        ),
      ),
    );
  return rows.length;
}

describe("task relation cycle prevention", () => {
  it("serializes concurrent reciprocal subtask inserts so only one edge survives", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const left = await insertTask({
      projectId: project.id,
      title: "Left",
      number: 1,
      columnId: columns.todo.id,
    });
    const right = await insertTask({
      projectId: project.id,
      title: "Right",
      number: 2,
      columnId: columns.todo.id,
    });

    const blocker = await getDatabasePool().connect();
    let lockHeld = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = true;

      const forward = createTaskRelation({
        sourceTaskId: left.id,
        targetTaskId: right.id,
        relationType: "subtask",
        userId: member.user.id,
        workspaceId: member.workspace.id,
      });
      const reverse = createTaskRelation({
        sourceTaskId: right.id,
        targetTaskId: left.id,
        relationType: "subtask",
        userId: member.user.id,
        workspaceId: member.workspace.id,
      });

      await waitForBlockedHierarchyMutations(2);
      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = false;

      const results = await withTimeout(
        Promise.allSettled([forward, reverse]),
        10_000,
      );

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ status: expect.any(Number) }),
      });
      expect([400, 409]).toContain(
        (rejected[0] as PromiseRejectedResult).reason.status,
      );
      expect(await countSubtaskEdges(left.id, right.id)).toBe(1);
    } finally {
      if (lockHeld) {
        await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
          member.workspace.id,
        ]);
      }
      blocker.release();
    }
  }, 20_000);

  it("rejects concurrent long-cycle closes so the hierarchy stays acyclic", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const a = await insertTask({
      projectId: project.id,
      title: "A",
      number: 1,
      columnId: columns.todo.id,
    });
    const b = await insertTask({
      projectId: project.id,
      title: "B",
      number: 2,
      columnId: columns.todo.id,
    });
    const c = await insertTask({
      projectId: project.id,
      title: "C",
      number: 3,
      columnId: columns.todo.id,
    });

    // Seed A → B. Concurrent B → C and C → A would race into A → B → C → A
    // without the workspace advisory lock + post-lock cycle check.
    await createTaskRelation({
      sourceTaskId: a.id,
      targetTaskId: b.id,
      relationType: "subtask",
      userId: member.user.id,
      workspaceId: member.workspace.id,
    });

    const blocker = await getDatabasePool().connect();
    let lockHeld = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = true;

      const extendChain = createTaskRelation({
        sourceTaskId: b.id,
        targetTaskId: c.id,
        relationType: "subtask",
        userId: member.user.id,
        workspaceId: member.workspace.id,
      });
      const closeCycle = createTaskRelation({
        sourceTaskId: c.id,
        targetTaskId: a.id,
        relationType: "subtask",
        userId: member.user.id,
        workspaceId: member.workspace.id,
      });

      await waitForBlockedHierarchyMutations(2);
      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = false;

      const results = await withTimeout(
        Promise.allSettled([extendChain, closeCycle]),
        10_000,
      );

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ status: 400 }),
      });

      const edges = await db
        .select({
          sourceTaskId: schema.taskRelationTable.sourceTaskId,
          targetTaskId: schema.taskRelationTable.targetTaskId,
        })
        .from(schema.taskRelationTable)
        .where(eq(schema.taskRelationTable.relationType, "subtask"));

      // Exactly one of the racing edges may land; never both (that would cycle).
      const hasBC = edges.some(
        (edge) => edge.sourceTaskId === b.id && edge.targetTaskId === c.id,
      );
      const hasCA = edges.some(
        (edge) => edge.sourceTaskId === c.id && edge.targetTaskId === a.id,
      );
      expect(hasBC !== hasCA).toBe(true);
      expect(edges).toHaveLength(2);
    } finally {
      if (lockHeld) {
        await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
          member.workspace.id,
        ]);
      }
      blocker.release();
    }
  }, 20_000);
});
