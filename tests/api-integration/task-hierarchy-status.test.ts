import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
import bulkUpdateTasks from "../../apps/api/src/task/controllers/bulk-update-tasks";
import deleteTask from "../../apps/api/src/task/controllers/delete-task";
import moveTask from "../../apps/api/src/task/controllers/move-task";
import { WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE } from "../../apps/api/src/task/controllers/task-cascade";
import updateTask from "../../apps/api/src/task/controllers/update-task";
import { updateTaskHierarchyStatus } from "../../apps/api/src/task/controllers/update-task-hierarchy-status";
import updateTaskStatus from "../../apps/api/src/task/controllers/update-task-status";
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

function isPostgresDeadlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    cause?: { code?: string };
  };
  return candidate.code === "40P01" || candidate.cause?.code === "40P01";
}

function eventCalls(type: string) {
  return mocks.publishEvent.mock.calls.filter(
    ([eventType]) => eventType === type,
  );
}

async function insertTask({
  projectId,
  title,
  number,
  columnId,
  status = "to-do",
  priority = "medium",
  userId,
  dueDate,
}: {
  projectId: string;
  title: string;
  number: number;
  columnId: string | null;
  status?: string;
  priority?: string;
  userId?: string | null;
  dueDate?: Date | null;
}) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      status,
      columnId,
      priority,
      number,
      position: number,
      userId: userId ?? null,
      dueDate: dueDate ?? null,
    })
    .returning();
  if (!task) throw new Error(`Failed to create task ${title}`);
  return task;
}

async function insertSubtask(parentId: string, childId: string) {
  const [relation] = await db
    .insert(schema.taskRelationTable)
    .values({
      sourceTaskId: parentId,
      targetTaskId: childId,
      relationType: "subtask",
    })
    .returning();
  if (!relation) throw new Error("Failed to create subtask relation");
  return relation;
}

async function loadTasks(ids: string[]) {
  return db
    .select({
      id: schema.taskTable.id,
      status: schema.taskTable.status,
      columnId: schema.taskTable.columnId,
      priority: schema.taskTable.priority,
      userId: schema.taskTable.userId,
      dueDate: schema.taskTable.dueDate,
      projectId: schema.taskTable.projectId,
    })
    .from(schema.taskTable)
    .where(inArray(schema.taskTable.id, ids));
}

describe("task hierarchy cascade status", () => {
  it("status change on a root cascades to all recursive subtask descendants", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const root = await insertTask({
      projectId: project.id,
      title: "Root",
      number: 1,
      columnId: columns.todo.id,
    });
    const child = await insertTask({
      projectId: project.id,
      title: "Child",
      number: 2,
      columnId: columns.todo.id,
    });
    const grandchild = await insertTask({
      projectId: project.id,
      title: "Grandchild",
      number: 3,
      columnId: columns.todo.id,
    });
    const blocked = await insertTask({
      projectId: project.id,
      title: "Blocked via non-subtask",
      number: 4,
      columnId: columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: root.id,
      targetTaskId: blocked.id,
      relationType: "blocks",
    });

    const updated = await updateTaskStatus({
      id: root.id,
      status: "in-progress",
      currentUserId: member.user.id,
    });

    expect(updated).toMatchObject({
      id: root.id,
      status: "in-progress",
      columnId: columns.inProgress.id,
    });

    const cascade = await loadTasks([
      root.id,
      child.id,
      grandchild.id,
      blocked.id,
    ]);
    const byId = new Map(cascade.map((task) => [task.id, task]));

    for (const id of [root.id, child.id, grandchild.id]) {
      expect(byId.get(id)).toMatchObject({
        status: "in-progress",
        columnId: columns.inProgress.id,
      });
    }
    expect(byId.get(blocked.id)).toMatchObject({
      status: "to-do",
      columnId: columns.todo.id,
    });

    const statusEvents = mocks.publishEvent.mock.calls.filter(
      ([type]) => type === "task.status_changed",
    );
    expect(statusEvents).toHaveLength(3);
    expect(statusEvents.map(([, payload]) => payload.taskId).sort()).toEqual(
      [root.id, child.id, grandchild.id].sort(),
    );
  });

  it("preflight rejects invalid status in any affected project with full rollback and no events", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const projectA = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project A",
      slug: "project-a",
    });
    const projectB = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project B",
      slug: "project-b",
    });

    const [specialColumn] = await db
      .insert(schema.columnTable)
      .values({
        projectId: projectA.project.id,
        name: "Special",
        slug: "special",
        position: 99,
        isFinal: false,
      })
      .returning();
    if (!specialColumn) throw new Error("Failed to create special column");

    const root = await insertTask({
      projectId: projectA.project.id,
      title: "Root A",
      number: 1,
      columnId: projectA.columns.todo.id,
    });
    const child = await insertTask({
      projectId: projectB.project.id,
      title: "Child B",
      number: 1,
      columnId: projectB.columns.todo.id,
    });
    await insertSubtask(root.id, child.id);

    await expect(
      updateTaskStatus({
        id: root.id,
        status: "special",
        currentUserId: member.user.id,
      }),
    ).rejects.toMatchObject({ status: 400 });

    const afterStatus = await loadTasks([root.id, child.id]);
    expect(afterStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: root.id,
          status: "to-do",
          columnId: projectA.columns.todo.id,
          projectId: projectA.project.id,
        }),
        expect.objectContaining({
          id: child.id,
          status: "to-do",
          columnId: projectB.columns.todo.id,
          projectId: projectB.project.id,
        }),
      ]),
    );
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    expect(eventCalls("task.status_changed")).toHaveLength(0);
    expect(eventCalls("task-relation.refresh")).toHaveLength(0);

    mocks.publishEvent.mockClear();

    await expect(
      updateTask(
        root.id,
        root.title,
        "special",
        undefined,
        undefined,
        projectA.project.id,
        root.description ?? "",
        root.priority,
        root.position,
        undefined,
        member.user.id,
      ),
    ).rejects.toMatchObject({ status: 400 });

    const afterFullUpdate = await loadTasks([root.id, child.id]);
    expect(afterFullUpdate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: root.id,
          status: "to-do",
          columnId: projectA.columns.todo.id,
          projectId: projectA.project.id,
        }),
        expect.objectContaining({
          id: child.id,
          status: "to-do",
          columnId: projectB.columns.todo.id,
          projectId: projectB.project.id,
        }),
      ]),
    );
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    expect(eventCalls("task.status_changed")).toHaveLength(0);
    expect(eventCalls("task-relation.refresh")).toHaveLength(0);

    await expect(
      db.transaction(async (tx) =>
        updateTaskHierarchyStatus(
          tx,
          member.workspace.id,
          [root.id],
          "special",
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("planned and archived clear columnId; normal statuses resolve project-specific columns", async () => {
    await resetTestDatabase();

    const member = await createWorkspaceMember();
    const projectA = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project A",
      slug: "project-a-cols",
    });
    const projectB = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project B",
      slug: "project-b-cols",
    });

    const root = await insertTask({
      projectId: projectA.project.id,
      title: "Root",
      number: 1,
      columnId: projectA.columns.todo.id,
    });
    const child = await insertTask({
      projectId: projectB.project.id,
      title: "Child",
      number: 1,
      columnId: projectB.columns.todo.id,
    });
    await insertSubtask(root.id, child.id);

    await updateTaskStatus({
      id: root.id,
      status: "done",
      currentUserId: member.user.id,
    });

    let rows = await loadTasks([root.id, child.id]);
    expect(rows.find((task) => task.id === root.id)).toMatchObject({
      status: "done",
      columnId: projectA.columns.done.id,
    });
    expect(rows.find((task) => task.id === child.id)).toMatchObject({
      status: "done",
      columnId: projectB.columns.done.id,
    });
    expect(projectA.columns.done.id).not.toBe(projectB.columns.done.id);

    await updateTaskStatus({
      id: root.id,
      status: "planned",
      currentUserId: member.user.id,
    });

    rows = await loadTasks([root.id, child.id]);
    for (const id of [root.id, child.id]) {
      expect(rows.find((task) => task.id === id)).toMatchObject({
        status: "planned",
        columnId: null,
      });
    }

    await updateTaskStatus({
      id: root.id,
      status: "archived",
      currentUserId: member.user.id,
    });

    rows = await loadTasks([root.id, child.id]);
    for (const id of [root.id, child.id]) {
      expect(rows.find((task) => task.id === id)).toMatchObject({
        status: "archived",
        columnId: null,
      });
    }
  });

  it("archive sets status archived with columnId null across root and descendants", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const root = await insertTask({
      projectId: project.id,
      title: "Root",
      number: 1,
      columnId: columns.inProgress.id,
      status: "in-progress",
    });
    const child = await insertTask({
      projectId: project.id,
      title: "Child",
      number: 2,
      columnId: columns.todo.id,
    });
    const grandchild = await insertTask({
      projectId: project.id,
      title: "Grandchild",
      number: 3,
      columnId: columns.done.id,
      status: "done",
    });

    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);

    const result = await bulkUpdateTasks({
      taskIds: [root.id],
      operation: "updateStatus",
      value: "archived",
      userId: member.user.id,
    });

    expect(result).toEqual({ success: true, updatedCount: 3 });

    const archived = await loadTasks([root.id, child.id, grandchild.id]);
    expect(archived).toHaveLength(3);
    for (const task of archived) {
      expect(task).toMatchObject({ status: "archived", columnId: null });
    }

    const statusEvents = mocks.publishEvent.mock.calls.filter(
      ([type]) => type === "task.status_changed",
    );
    expect(statusEvents).toHaveLength(3);
    expect(
      statusEvents.every(([, payload]) => payload.newStatus === "archived"),
    ).toBe(true);
  });

  it("overlapping bulk roots dedupe and emit events only for actually-changed tasks after commit", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const root = await insertTask({
      projectId: project.id,
      title: "Root",
      number: 1,
      columnId: columns.todo.id,
    });
    const child = await insertTask({
      projectId: project.id,
      title: "Child",
      number: 2,
      columnId: columns.inProgress.id,
      status: "in-progress",
    });
    const grandchild = await insertTask({
      projectId: project.id,
      title: "Grandchild",
      number: 3,
      columnId: columns.inProgress.id,
      status: "in-progress",
    });
    const sibling = await insertTask({
      projectId: project.id,
      title: "Sibling",
      number: 4,
      columnId: columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);
    await insertSubtask(root.id, sibling.id);

    // Overlapping roots; child + grandchild already at target status/column.
    const result = await bulkUpdateTasks({
      taskIds: [root.id, child.id, root.id],
      operation: "updateStatus",
      value: "in-progress",
      userId: member.user.id,
    });

    expect(result).toEqual({ success: true, updatedCount: 2 });

    const rows = await loadTasks([
      root.id,
      child.id,
      grandchild.id,
      sibling.id,
    ]);
    for (const task of rows) {
      expect(task).toMatchObject({
        status: "in-progress",
        columnId: columns.inProgress.id,
      });
    }

    const statusEvents = mocks.publishEvent.mock.calls.filter(
      ([type]) => type === "task.status_changed",
    );
    expect(statusEvents).toHaveLength(2);
    expect(statusEvents.map(([, payload]) => payload.taskId).sort()).toEqual(
      [root.id, sibling.id].sort(),
    );

    await expect(
      db.transaction(async (tx) => {
        const hierarchyResult = await updateTaskHierarchyStatus(
          tx,
          member.workspace.id,
          [root.id],
          "done",
        );
        expect(
          hierarchyResult.changedTasks.map((task) => task.id).sort(),
        ).toEqual([root.id, child.id, grandchild.id, sibling.id].sort());
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const stillInProgress = await loadTasks([root.id, sibling.id]);
    expect(
      stillInProgress.every(
        (task) =>
          task.status === "in-progress" &&
          task.columnId === columns.inProgress.id,
      ),
    ).toBe(true);
  });

  it("priority, assignee, dates, labels, and move do not cascade to subtask descendants", async () => {
    await resetTestDatabase();

    const member = await createWorkspaceMember();
    const assigneeId = `user-${randomUUID()}`;
    await db.insert(schema.userTable).values({
      id: assigneeId,
      email: `${assigneeId}@example.com`,
      emailVerified: true,
      name: "Workspace Assignee",
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: member.workspace.id,
      userId: assigneeId,
      role: "member",
      joinedAt: new Date(),
    });

    const source = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Source",
      slug: "source-project",
    });
    const destination = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Destination",
      slug: "destination-project",
    });

    const root = await insertTask({
      projectId: source.project.id,
      title: "Root",
      number: 1,
      columnId: source.columns.todo.id,
      priority: "medium",
    });
    const child = await insertTask({
      projectId: source.project.id,
      title: "Child",
      number: 2,
      columnId: source.columns.todo.id,
      priority: "medium",
    });
    await insertSubtask(root.id, child.id);

    const [labelDefinition] = await db
      .insert(schema.labelTable)
      .values({
        name: "cascade-check",
        color: "#ff0000",
        workspaceId: member.workspace.id,
        taskId: null,
      })
      .returning();
    if (!labelDefinition) throw new Error("Failed to create label");

    await bulkUpdateTasks({
      taskIds: [root.id],
      operation: "updatePriority",
      value: "urgent",
      userId: member.user.id,
    });
    await bulkUpdateTasks({
      taskIds: [root.id],
      operation: "updateAssignee",
      value: assigneeId,
      userId: member.user.id,
    });
    await bulkUpdateTasks({
      taskIds: [root.id],
      operation: "updateDueDate",
      value: "2030-01-15T00:00:00.000Z",
      userId: member.user.id,
    });
    await bulkUpdateTasks({
      taskIds: [root.id],
      operation: "addLabel",
      value: labelDefinition.id,
      userId: member.user.id,
    });

    let rows = await loadTasks([root.id, child.id]);
    expect(rows.find((task) => task.id === root.id)).toMatchObject({
      priority: "urgent",
      userId: assigneeId,
    });
    expect(rows.find((task) => task.id === child.id)).toMatchObject({
      priority: "medium",
      userId: null,
      dueDate: null,
    });
    expect(rows.find((task) => task.id === root.id)?.dueDate).toEqual(
      new Date("2030-01-15T00:00:00.000Z"),
    );

    const rootLabels = await db
      .select()
      .from(schema.labelTable)
      .where(
        and(
          eq(schema.labelTable.taskId, root.id),
          eq(schema.labelTable.name, "cascade-check"),
        ),
      );
    const childLabels = await db
      .select()
      .from(schema.labelTable)
      .where(
        and(
          eq(schema.labelTable.taskId, child.id),
          eq(schema.labelTable.name, "cascade-check"),
        ),
      );
    expect(rootLabels).toHaveLength(1);
    expect(childLabels).toHaveLength(0);

    await moveTask({
      taskId: root.id,
      destinationProjectId: destination.project.id,
      currentUserId: member.user.id,
    });

    rows = await loadTasks([root.id, child.id]);
    expect(rows.find((task) => task.id === root.id)?.projectId).toBe(
      destination.project.id,
    );
    expect(rows.find((task) => task.id === child.id)?.projectId).toBe(
      source.project.id,
    );
  });

  it("full update versus cascade delete does not deadlock on overlapping hierarchy", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const root = await insertTask({
      projectId: project.id,
      title: "Root",
      number: 1,
      columnId: columns.todo.id,
    });
    const child = await insertTask({
      projectId: project.id,
      title: "Child",
      number: 2,
      columnId: columns.todo.id,
    });
    const grandchild = await insertTask({
      projectId: project.id,
      title: "Grandchild",
      number: 3,
      columnId: columns.todo.id,
    });
    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);

    const hierarchyIds = [root.id, child.id, grandchild.id];
    const blocker = await getDatabasePool().connect();
    let lockHeld = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = true;

      const updatePromise = updateTask(
        root.id,
        root.title,
        "in-progress",
        undefined,
        undefined,
        project.id,
        root.description ?? "",
        root.priority,
        root.position,
        undefined,
        member.user.id,
      );
      const deletePromise = deleteTask(root.id, member.user.id);

      await waitForBlockedHierarchyMutations(2);
      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = false;

      const results = await withTimeout(
        Promise.allSettled([updatePromise, deletePromise]),
        10_000,
      );
      const [updateResult, deleteResult] = results;

      for (const result of results) {
        if (result.status === "rejected") {
          expect(isPostgresDeadlock(result.reason)).toBe(false);
        }
      }

      const remaining = await loadTasks(hierarchyIds);

      if (deleteResult.status === "fulfilled") {
        // Delete (possibly after a prior full update) removed the whole hierarchy.
        expect(remaining).toHaveLength(0);
        if (updateResult.status === "rejected") {
          expect(updateResult.reason).toMatchObject({ status: 404 });
        }
      } else if (updateResult.status === "fulfilled") {
        // Update committed; delete failed without leaving a partial cascade.
        expect(remaining).toHaveLength(3);
        for (const task of remaining) {
          expect(task).toMatchObject({
            status: "in-progress",
            columnId: columns.inProgress.id,
            projectId: project.id,
          });
        }
      } else {
        throw new Error(
          "Both update and delete rejected without a valid serialized outcome",
        );
      }
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

  it("move versus parent status cascade keeps child project/column consistent", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const source = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Source",
      slug: "source-move-cascade",
    });
    const destination = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Destination",
      slug: "dest-move-cascade",
    });

    expect(source.columns.inProgress.id).not.toBe(
      destination.columns.inProgress.id,
    );
    expect(source.columns.todo.id).not.toBe(destination.columns.todo.id);

    const parent = await insertTask({
      projectId: source.project.id,
      title: "Parent",
      number: 1,
      columnId: source.columns.todo.id,
    });
    const child = await insertTask({
      projectId: source.project.id,
      title: "Child",
      number: 2,
      columnId: source.columns.todo.id,
    });
    await insertSubtask(parent.id, child.id);

    const destinationColumnIds = new Set(
      Object.values(destination.columns).map((column) => column.id),
    );
    const sourceColumnIds = new Set(
      Object.values(source.columns).map((column) => column.id),
    );

    const blocker = await getDatabasePool().connect();
    let lockHeld = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = true;

      const movePromise = moveTask({
        taskId: child.id,
        destinationProjectId: destination.project.id,
        currentUserId: member.user.id,
      });
      const statusPromise = updateTaskStatus({
        id: parent.id,
        status: "in-progress",
        currentUserId: member.user.id,
      });

      await waitForBlockedHierarchyMutations(2);
      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = false;

      const results = await withTimeout(
        Promise.allSettled([movePromise, statusPromise]),
        10_000,
      );

      for (const result of results) {
        expect(result.status).toBe("fulfilled");
        if (result.status === "rejected") {
          expect(isPostgresDeadlock(result.reason)).toBe(false);
        }
      }

      const [finalChild] = await loadTasks([child.id]);
      if (!finalChild) throw new Error("Child task missing after race");

      expect(finalChild.projectId).toBe(destination.project.id);
      expect(destinationColumnIds.has(finalChild.columnId ?? "")).toBe(true);
      expect(sourceColumnIds.has(finalChild.columnId ?? "")).toBe(false);

      const destColumnForStatus = Object.values(destination.columns).find(
        (column) => column.slug === finalChild.status,
      );
      expect(destColumnForStatus).toBeDefined();
      expect(finalChild.columnId).toBe(destColumnForStatus?.id);
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

  it("publishes task-relation.refresh once per affected project after commit for status and full update", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const projectA = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project A",
      slug: "refresh-project-a",
    });
    const projectB = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project B",
      slug: "refresh-project-b",
    });

    const root = await insertTask({
      projectId: projectA.project.id,
      title: "Root",
      number: 1,
      columnId: projectA.columns.todo.id,
    });
    const child = await insertTask({
      projectId: projectB.project.id,
      title: "Child",
      number: 1,
      columnId: projectB.columns.todo.id,
    });
    await insertSubtask(root.id, child.id);

    const expectedProjectIds = [
      projectA.project.id,
      projectB.project.id,
    ].sort();

    await expect(
      db.transaction(async (tx) => {
        await updateTaskHierarchyStatus(
          tx,
          member.workspace.id,
          [root.id],
          "in-progress",
        );
        throw new Error("force rollback before commit");
      }),
    ).rejects.toThrow("force rollback before commit");

    expect(mocks.publishEvent).not.toHaveBeenCalled();
    const rolledBack = await loadTasks([root.id, child.id]);
    expect(rolledBack).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: root.id,
          status: "to-do",
          columnId: projectA.columns.todo.id,
        }),
        expect.objectContaining({
          id: child.id,
          status: "to-do",
          columnId: projectB.columns.todo.id,
        }),
      ]),
    );

    mocks.publishEvent.mockClear();
    await updateTaskStatus({
      id: root.id,
      status: "in-progress",
      currentUserId: member.user.id,
    });

    const statusChangedAfterStatus = eventCalls("task.status_changed");
    expect(statusChangedAfterStatus).toHaveLength(2);
    expect(
      statusChangedAfterStatus.map(([, payload]) => payload.taskId).sort(),
    ).toEqual([root.id, child.id].sort());

    const refreshAfterStatus = eventCalls("task-relation.refresh");
    expect(
      refreshAfterStatus.map(([, payload]) => payload.projectId).sort(),
    ).toEqual(expectedProjectIds);
    expect(
      new Set(refreshAfterStatus.map(([, payload]) => payload.projectId)).size,
    ).toBe(2);

    const afterStatus = await loadTasks([root.id, child.id]);
    expect(afterStatus.find((task) => task.id === root.id)).toMatchObject({
      status: "in-progress",
      columnId: projectA.columns.inProgress.id,
      projectId: projectA.project.id,
    });
    expect(afterStatus.find((task) => task.id === child.id)).toMatchObject({
      status: "in-progress",
      columnId: projectB.columns.inProgress.id,
      projectId: projectB.project.id,
    });

    mocks.publishEvent.mockClear();
    await updateTask(
      root.id,
      root.title,
      "done",
      undefined,
      undefined,
      projectA.project.id,
      root.description ?? "",
      root.priority,
      root.position,
      undefined,
      member.user.id,
    );

    const statusChangedAfterFull = eventCalls("task.status_changed");
    expect(statusChangedAfterFull).toHaveLength(2);
    expect(
      statusChangedAfterFull.map(([, payload]) => payload.taskId).sort(),
    ).toEqual([root.id, child.id].sort());

    const refreshAfterFull = eventCalls("task-relation.refresh");
    expect(
      refreshAfterFull.map(([, payload]) => payload.projectId).sort(),
    ).toEqual(expectedProjectIds);
    expect(
      new Set(refreshAfterFull.map(([, payload]) => payload.projectId)).size,
    ).toBe(2);
  });

  it("mixed valid/missing bulk status is fail-closed with no writes or events", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const root = await insertTask({
      projectId: project.id,
      title: "Root",
      number: 1,
      columnId: columns.todo.id,
    });
    const child = await insertTask({
      projectId: project.id,
      title: "Child",
      number: 2,
      columnId: columns.todo.id,
    });
    await insertSubtask(root.id, child.id);

    const missingId = `missing-${randomUUID()}`;

    await expect(
      bulkUpdateTasks({
        taskIds: [root.id, missingId],
        operation: "updateStatus",
        value: "in-progress",
        userId: member.user.id,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const rows = await loadTasks([root.id, child.id]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: root.id,
          status: "to-do",
          columnId: columns.todo.id,
        }),
        expect.objectContaining({
          id: child.id,
          status: "to-do",
          columnId: columns.todo.id,
        }),
      ]),
    );
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    expect(eventCalls("task.status_changed")).toHaveLength(0);
    expect(eventCalls("task-relation.refresh")).toHaveLength(0);
  });
});
