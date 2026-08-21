import { and, eq, or } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publishEvent: vi.fn(async () => {}),
}));

vi.mock("../../apps/api/src/events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/api/src/events")>();
  return {
    ...actual,
    publishEvent: mocks.publishEvent,
  };
});

import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE } from "../../apps/api/src/task/controllers/task-cascade";
import createTaskRelation from "../../apps/api/src/task-relation/controllers/create-task-relation";
import deleteTaskRelation from "../../apps/api/src/task-relation/controllers/delete-task-relation";
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

function eventCalls(type: string) {
  return mocks.publishEvent.mock.calls.filter(
    ([eventType]) => eventType === type,
  );
}

type RelationEventPayload = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  createdAt: Date;
  taskId: string;
  projectId: string;
  userId: string;
};

function withoutProjectId(payload: RelationEventPayload) {
  const { projectId: _projectId, ...rest } = payload;
  return rest;
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

async function observeRelationVisibilityOnPublish(
  observer: Awaited<ReturnType<ReturnType<typeof getDatabasePool>["connect"]>>,
) {
  mocks.publishEvent.mockImplementation(
    async (eventType: string, payload: RelationEventPayload) => {
      if (
        eventType !== "task-relation.created" &&
        eventType !== "task-relation.deleted"
      ) {
        return;
      }

      const result = await observer.query<{ id: string }>(
        "SELECT id FROM task_relation WHERE id = $1",
        [payload.id],
      );

      if (eventType === "task-relation.created") {
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.id).toBe(payload.id);
      } else {
        expect(result.rows).toHaveLength(0);
      }
    },
  );
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

  it("fans out create/delete events across projects after commit", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const projectA = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project A",
      slug: "relation-fanout-a",
    });
    const projectB = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project B",
      slug: "relation-fanout-b",
    });

    const source = await insertTask({
      projectId: projectA.project.id,
      title: "Source",
      number: 1,
      columnId: projectA.columns.todo.id,
    });
    const target = await insertTask({
      projectId: projectB.project.id,
      title: "Target",
      number: 1,
      columnId: projectB.columns.todo.id,
    });

    const observer = await getDatabasePool().connect();
    try {
      await observeRelationVisibilityOnPublish(observer);

      const created = await createTaskRelation({
        sourceTaskId: source.id,
        targetTaskId: target.id,
        relationType: "related",
        userId: member.user.id,
        workspaceId: member.workspace.id,
      });

      const createdEvents = eventCalls("task-relation.created");
      expect(createdEvents).toHaveLength(2);
      expect(
        createdEvents.map(([, payload]) => payload.projectId).sort(),
      ).toEqual([projectA.project.id, projectB.project.id].sort());

      for (const [, payload] of createdEvents) {
        expect(payload).toEqual(
          expect.objectContaining({
            id: created.id,
            sourceTaskId: created.sourceTaskId,
            targetTaskId: created.targetTaskId,
            relationType: created.relationType,
            createdAt: created.createdAt,
            taskId: source.id,
            userId: member.user.id,
          }),
        );
        expect(payload.createdAt).toBeInstanceOf(Date);
        expect(payload.createdAt).toEqual(created.createdAt);
      }

      expect(
        withoutProjectId(createdEvents[0]?.[1] as RelationEventPayload),
      ).toEqual(
        withoutProjectId(createdEvents[1]?.[1] as RelationEventPayload),
      );

      mocks.publishEvent.mockClear();
      await observeRelationVisibilityOnPublish(observer);

      const deleted = await deleteTaskRelation(created.id, member.user.id);

      const deletedEvents = eventCalls("task-relation.deleted");
      expect(deletedEvents).toHaveLength(2);
      expect(
        deletedEvents.map(([, payload]) => payload.projectId).sort(),
      ).toEqual([projectA.project.id, projectB.project.id].sort());

      for (const [, payload] of deletedEvents) {
        expect(payload).toEqual(
          expect.objectContaining({
            id: deleted.id,
            sourceTaskId: deleted.sourceTaskId,
            targetTaskId: deleted.targetTaskId,
            relationType: deleted.relationType,
            createdAt: deleted.createdAt,
            taskId: deleted.sourceTaskId,
            userId: member.user.id,
          }),
        );
        expect(payload.createdAt).toBeInstanceOf(Date);
        expect(payload.createdAt).toEqual(deleted.createdAt);
        expect(payload.createdAt).toEqual(created.createdAt);
      }

      expect(
        withoutProjectId(deletedEvents[0]?.[1] as RelationEventPayload),
      ).toEqual(
        withoutProjectId(deletedEvents[1]?.[1] as RelationEventPayload),
      );
    } finally {
      mocks.publishEvent.mockReset();
      mocks.publishEvent.mockImplementation(async () => {});
      observer.release();
    }
  });

  it("emits a single create/delete event when both endpoints share a project", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const source = await insertTask({
      projectId: project.id,
      title: "Same-project source",
      number: 1,
      columnId: columns.todo.id,
    });
    const target = await insertTask({
      projectId: project.id,
      title: "Same-project target",
      number: 2,
      columnId: columns.todo.id,
    });

    const observer = await getDatabasePool().connect();
    try {
      await observeRelationVisibilityOnPublish(observer);

      const created = await createTaskRelation({
        sourceTaskId: source.id,
        targetTaskId: target.id,
        relationType: "blocks",
        userId: member.user.id,
        workspaceId: member.workspace.id,
      });

      const createdEvents = eventCalls("task-relation.created");
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]?.[1]).toEqual(
        expect.objectContaining({
          id: created.id,
          sourceTaskId: created.sourceTaskId,
          targetTaskId: created.targetTaskId,
          relationType: created.relationType,
          createdAt: created.createdAt,
          taskId: source.id,
          projectId: project.id,
          userId: member.user.id,
        }),
      );
      expect(createdEvents[0]?.[1].createdAt).toBeInstanceOf(Date);
      expect(createdEvents[0]?.[1].createdAt).toEqual(created.createdAt);

      mocks.publishEvent.mockClear();
      await observeRelationVisibilityOnPublish(observer);

      const deleted = await deleteTaskRelation(created.id, member.user.id);

      const deletedEvents = eventCalls("task-relation.deleted");
      expect(deletedEvents).toHaveLength(1);
      expect(deletedEvents[0]?.[1]).toEqual(
        expect.objectContaining({
          id: deleted.id,
          sourceTaskId: deleted.sourceTaskId,
          targetTaskId: deleted.targetTaskId,
          relationType: deleted.relationType,
          createdAt: deleted.createdAt,
          taskId: deleted.sourceTaskId,
          projectId: project.id,
          userId: member.user.id,
        }),
      );
      expect(deletedEvents[0]?.[1].createdAt).toBeInstanceOf(Date);
      expect(deletedEvents[0]?.[1].createdAt).toEqual(deleted.createdAt);
      expect(deletedEvents[0]?.[1].createdAt).toEqual(created.createdAt);
    } finally {
      mocks.publishEvent.mockReset();
      mocks.publishEvent.mockImplementation(async () => {});
      observer.release();
    }
  });
});
