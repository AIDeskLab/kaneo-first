import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publishEvent: vi.fn(async () => {}),
  cleanupAssetKeys: vi.fn(async () => {}),
}));

vi.mock("../../apps/api/src/events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/api/src/events")>();
  return {
    ...actual,
    publishEvent: mocks.publishEvent,
  };
});

vi.mock("../../apps/api/src/storage/cleanup-assets", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../apps/api/src/storage/cleanup-assets")
    >();
  return {
    ...actual,
    cleanupAssetKeys: mocks.cleanupAssetKeys,
  };
});

import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import bulkUpdateTasks from "../../apps/api/src/task/controllers/bulk-update-tasks";
import deleteTask from "../../apps/api/src/task/controllers/delete-task";
import { deleteTaskHierarchy } from "../../apps/api/src/task/controllers/delete-task-hierarchy";
import getTask from "../../apps/api/src/task/controllers/get-task";
import moveTask from "../../apps/api/src/task/controllers/move-task";
import { WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE } from "../../apps/api/src/task/controllers/task-cascade";
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

async function insertAsset({
  workspaceId,
  projectId,
  taskId,
  objectKey,
}: {
  workspaceId: string;
  projectId: string;
  taskId: string;
  objectKey: string;
}) {
  const [asset] = await db
    .insert(schema.assetTable)
    .values({
      workspaceId,
      projectId,
      taskId,
      objectKey,
      filename: `${objectKey}.png`,
      mimeType: "image/png",
      size: 128,
      kind: "image",
      surface: "description",
    })
    .returning();
  if (!asset) throw new Error(`Failed to create asset ${objectKey}`);
  return asset;
}

describe("task hierarchy cascade delete", () => {
  it("single delete returns the root task, cascades descendants, then 404s", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

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

    const returned = await deleteTask(root.id, member.user.id);

    expect(returned).toMatchObject({
      id: root.id,
      title: root.title,
      projectId: project.id,
    });

    await expect(getTask(root.id)).rejects.toMatchObject({ status: 404 });
    await expect(getTask(child.id)).rejects.toMatchObject({ status: 404 });
    await expect(getTask(grandchild.id)).rejects.toMatchObject({ status: 404 });

    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task.deleted",
      expect.objectContaining({ taskId: root.id, title: root.title }),
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task.deleted",
      expect.objectContaining({ taskId: child.id }),
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task.deleted",
      expect.objectContaining({ taskId: grandchild.id }),
    );
    expect(mocks.cleanupAssetKeys).toHaveBeenCalled();
  });

  it("bulk delete of overlapping roots deletes each descendant once", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

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
    const sibling = await insertTask({
      projectId: project.id,
      title: "Sibling branch",
      number: 4,
      columnId: columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);
    await insertSubtask(root.id, sibling.id);

    // Overlapping roots: parent + nested child share the same descendant set.
    const result = await bulkUpdateTasks({
      taskIds: [root.id, child.id, root.id],
      operation: "delete",
      userId: member.user.id,
    });

    expect(result).toEqual({ success: true, updatedCount: 4 });

    const remaining = await db
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(
        inArray(schema.taskTable.id, [
          root.id,
          child.id,
          grandchild.id,
          sibling.id,
        ]),
      );
    expect(remaining).toEqual([]);

    const deletedTaskEvents = eventCalls("task.deleted");
    expect(deletedTaskEvents).toHaveLength(4);
    expect(mocks.cleanupAssetKeys).toHaveBeenCalledTimes(1);
  });

  it("does not traverse blocks or related edges when cascading delete", async () => {
    await resetTestDatabase();

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
    const blocked = await insertTask({
      projectId: project.id,
      title: "Blocked",
      number: 3,
      columnId: columns.todo.id,
    });
    const related = await insertTask({
      projectId: project.id,
      title: "Related",
      number: 4,
      columnId: columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    await db.insert(schema.taskRelationTable).values([
      {
        sourceTaskId: root.id,
        targetTaskId: blocked.id,
        relationType: "blocks",
      },
      {
        sourceTaskId: root.id,
        targetTaskId: related.id,
        relationType: "related",
      },
    ]);

    await deleteTask(root.id, member.user.id);

    await expect(getTask(root.id)).rejects.toMatchObject({ status: 404 });
    await expect(getTask(child.id)).rejects.toMatchObject({ status: 404 });

    const survivors = await db
      .select({ id: schema.taskTable.id, title: schema.taskTable.title })
      .from(schema.taskTable)
      .where(inArray(schema.taskTable.id, [blocked.id, related.id]));
    expect(survivors.map((task) => task.id).sort()).toEqual(
      [blocked.id, related.id].sort(),
    );

    const leftoverRelations = await db
      .select()
      .from(schema.taskRelationTable)
      .where(
        or(
          inArray(schema.taskRelationTable.sourceTaskId, [
            root.id,
            child.id,
            blocked.id,
            related.id,
          ]),
          inArray(schema.taskRelationTable.targetTaskId, [
            root.id,
            child.id,
            blocked.id,
            related.id,
          ]),
        ),
      );
    expect(leftoverRelations).toEqual([]);
  });

  it("removes FK dependents, snapshots asset keys, and skips side effects on rollback", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

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

    await db.insert(schema.activityTable).values({
      taskId: child.id,
      type: "comment",
      userId: member.user.id,
      content: "child activity",
    });
    await db.insert(schema.commentTable).values({
      taskId: root.id,
      userId: member.user.id,
      content: "root comment",
    });

    const rootAssetKey = `tasks/${root.id}/root.png`;
    const childAssetKey = `tasks/${child.id}/child.png`;
    await insertAsset({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: root.id,
      objectKey: rootAssetKey,
    });
    await insertAsset({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: child.id,
      objectKey: childAssetKey,
    });

    await expect(
      db.transaction(async (tx) => {
        const result = await deleteTaskHierarchy(tx, member.workspace.id, [
          root.id,
        ]);

        expect(result.deletedTasks.map((task) => task.id).sort()).toEqual(
          [root.id, child.id].sort(),
        );
        expect(result.assetKeys.sort()).toEqual(
          [rootAssetKey, childAssetKey].sort(),
        );
        expect(result.deletedRelations.length).toBeGreaterThan(0);

        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    // Side effects must not run before the surrounding transaction commits.
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    expect(eventCalls("task.deleted")).toHaveLength(0);
    expect(eventCalls("task-relation.deleted")).toHaveLength(0);
    expect(mocks.cleanupAssetKeys).not.toHaveBeenCalled();

    expect(
      await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, root.id),
      }),
    ).toBeDefined();
    expect(
      await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, child.id),
      }),
    ).toBeDefined();
    expect(
      await db.query.assetTable.findFirst({
        where: eq(schema.assetTable.objectKey, rootAssetKey),
      }),
    ).toBeDefined();
    expect(
      await db.query.activityTable.findFirst({
        where: and(
          eq(schema.activityTable.taskId, child.id),
          eq(schema.activityTable.type, "comment"),
        ),
      }),
    ).toBeDefined();
    expect(
      await db.query.commentTable.findFirst({
        where: eq(schema.commentTable.taskId, root.id),
      }),
    ).toBeDefined();
    expect(
      await db.query.taskRelationTable.findFirst({
        where: and(
          eq(schema.taskRelationTable.sourceTaskId, root.id),
          eq(schema.taskRelationTable.targetTaskId, child.id),
        ),
      }),
    ).toBeDefined();

    const committed = await deleteTask(root.id, member.user.id);
    expect(committed.id).toBe(root.id);

    expect(
      await db
        .select()
        .from(schema.taskTable)
        .where(inArray(schema.taskTable.id, [root.id, child.id])),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.assetTable)
        .where(
          inArray(schema.assetTable.objectKey, [rootAssetKey, childAssetKey]),
        ),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.activityTable)
        .where(eq(schema.activityTable.taskId, child.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.commentTable)
        .where(eq(schema.commentTable.taskId, root.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.taskRelationTable)
        .where(
          or(
            inArray(schema.taskRelationTable.sourceTaskId, [root.id, child.id]),
            inArray(schema.taskRelationTable.targetTaskId, [root.id, child.id]),
          ),
        ),
    ).toEqual([]);

    expect(mocks.cleanupAssetKeys).toHaveBeenCalledWith(
      expect.arrayContaining([rootAssetKey, childAssetKey]),
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task.deleted",
      expect.objectContaining({ taskId: root.id }),
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task-relation.deleted",
      expect.objectContaining({
        sourceTaskId: root.id,
        targetTaskId: child.id,
      }),
    );
  });

  it("mixed valid/missing bulk delete is fail-closed with no writes or side effects", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

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
    const external = await insertTask({
      projectId: project.id,
      title: "External",
      number: 4,
      columnId: columns.todo.id,
    });

    const subtaskRootChild = await insertSubtask(root.id, child.id);
    const subtaskChildGrandchild = await insertSubtask(child.id, grandchild.id);
    const [incidentRelation] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: root.id,
        targetTaskId: external.id,
        relationType: "blocks",
      })
      .returning();
    if (!incidentRelation)
      throw new Error("Failed to create incident relation");

    const rootAssetKey = `tasks/${root.id}/fail-closed-root.png`;
    const childAssetKey = `tasks/${child.id}/fail-closed-child.png`;
    await insertAsset({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: root.id,
      objectKey: rootAssetKey,
    });
    await insertAsset({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: child.id,
      objectKey: childAssetKey,
    });

    const missingId = `missing-${randomUUID()}`;

    await expect(
      bulkUpdateTasks({
        taskIds: [root.id, missingId],
        operation: "delete",
        userId: member.user.id,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const remainingTasks = await db
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(
        inArray(schema.taskTable.id, [
          root.id,
          child.id,
          grandchild.id,
          external.id,
        ]),
      );
    expect(remainingTasks.map((task) => task.id).sort()).toEqual(
      [root.id, child.id, grandchild.id, external.id].sort(),
    );

    const remainingRelations = await db
      .select({ id: schema.taskRelationTable.id })
      .from(schema.taskRelationTable)
      .where(
        inArray(schema.taskRelationTable.id, [
          subtaskRootChild.id,
          subtaskChildGrandchild.id,
          incidentRelation.id,
        ]),
      );
    expect(remainingRelations.map((relation) => relation.id).sort()).toEqual(
      [
        subtaskRootChild.id,
        subtaskChildGrandchild.id,
        incidentRelation.id,
      ].sort(),
    );

    const remainingAssets = await db
      .select({ objectKey: schema.assetTable.objectKey })
      .from(schema.assetTable)
      .where(
        inArray(schema.assetTable.objectKey, [rootAssetKey, childAssetKey]),
      );
    expect(remainingAssets.map((asset) => asset.objectKey).sort()).toEqual(
      [rootAssetKey, childAssetKey].sort(),
    );

    expect(eventCalls("task.deleted")).toHaveLength(0);
    expect(eventCalls("task-relation.deleted")).toHaveLength(0);
    expect(mocks.cleanupAssetKeys).not.toHaveBeenCalled();
  });

  it("cascade deletion preserves the complete relation event contract", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

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
    const external = await insertTask({
      projectId: project.id,
      title: "External",
      number: 3,
      columnId: columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    const [incidentRelation] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: root.id,
        targetTaskId: external.id,
        relationType: "blocks",
      })
      .returning();
    if (!incidentRelation)
      throw new Error("Failed to create incident relation");

    await deleteTask(root.id, member.user.id);

    const relationDeletedEvents = eventCalls("task-relation.deleted");
    const incidentEvents = relationDeletedEvents.filter(
      ([, payload]) => payload.id === incidentRelation.id,
    );

    expect(incidentEvents.length).toBeGreaterThan(0);
    for (const [, payload] of incidentEvents) {
      expect(payload).toEqual(
        expect.objectContaining({
          id: incidentRelation.id,
          sourceTaskId: incidentRelation.sourceTaskId,
          targetTaskId: incidentRelation.targetTaskId,
          relationType: incidentRelation.relationType,
          createdAt: incidentRelation.createdAt,
          userId: member.user.id,
          taskId: root.id,
          projectId: project.id,
        }),
      );
      expect(payload.createdAt).toBeInstanceOf(Date);
      expect(payload.createdAt).toEqual(incidentRelation.createdAt);
    }
  });

  it("cascade relation events fan out across projects and dedupe within a project", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

    const member = await createWorkspaceMember();
    const projectA = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project A",
      slug: "delete-fanout-a",
    });
    const projectB = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project B",
      slug: "delete-fanout-b",
    });

    const root = await insertTask({
      projectId: projectA.project.id,
      title: "Root",
      number: 1,
      columnId: projectA.columns.todo.id,
    });
    const child = await insertTask({
      projectId: projectA.project.id,
      title: "Child",
      number: 2,
      columnId: projectA.columns.todo.id,
    });
    const crossProject = await insertTask({
      projectId: projectB.project.id,
      title: "Cross-project endpoint",
      number: 1,
      columnId: projectB.columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    const [crossRelation] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: root.id,
        targetTaskId: crossProject.id,
        relationType: "related",
      })
      .returning();
    if (!crossRelation)
      throw new Error("Failed to create cross-project relation");

    await deleteTask(root.id, member.user.id);

    await expect(getTask(crossProject.id)).resolves.toMatchObject({
      id: crossProject.id,
      projectId: projectB.project.id,
    });

    const crossRelationEvents = eventCalls("task-relation.deleted").filter(
      ([, payload]) => payload.id === crossRelation.id,
    );
    expect(crossRelationEvents).toHaveLength(2);
    expect(
      crossRelationEvents.map(([, payload]) => payload.projectId).sort(),
    ).toEqual([projectA.project.id, projectB.project.id].sort());

    for (const [, payload] of crossRelationEvents) {
      expect(payload).toEqual(
        expect.objectContaining({
          id: crossRelation.id,
          sourceTaskId: crossRelation.sourceTaskId,
          targetTaskId: crossRelation.targetTaskId,
          relationType: crossRelation.relationType,
          createdAt: crossRelation.createdAt,
          userId: member.user.id,
          taskId: root.id,
        }),
      );
      expect(payload.createdAt).toBeInstanceOf(Date);
      expect(payload.createdAt).toEqual(crossRelation.createdAt);
    }

    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

    const sameProjectRoot = await insertTask({
      projectId: projectA.project.id,
      title: "Same-project root",
      number: 10,
      columnId: projectA.columns.todo.id,
    });
    const sameProjectPeer = await insertTask({
      projectId: projectA.project.id,
      title: "Same-project peer",
      number: 11,
      columnId: projectA.columns.todo.id,
    });
    const [sameProjectRelation] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: sameProjectRoot.id,
        targetTaskId: sameProjectPeer.id,
        relationType: "blocks",
      })
      .returning();
    if (!sameProjectRelation) {
      throw new Error("Failed to create same-project incident relation");
    }

    await deleteTask(sameProjectRoot.id, member.user.id);

    const sameProjectEvents = eventCalls("task-relation.deleted").filter(
      ([, payload]) => payload.id === sameProjectRelation.id,
    );
    expect(sameProjectEvents).toHaveLength(1);
    expect(sameProjectEvents[0]?.[1]).toEqual(
      expect.objectContaining({
        id: sameProjectRelation.id,
        sourceTaskId: sameProjectRelation.sourceTaskId,
        targetTaskId: sameProjectRelation.targetTaskId,
        relationType: sameProjectRelation.relationType,
        createdAt: sameProjectRelation.createdAt,
        userId: member.user.id,
        taskId: sameProjectRoot.id,
        projectId: projectA.project.id,
      }),
    );
    expect(sameProjectEvents[0]?.[1].createdAt).toBeInstanceOf(Date);
    expect(sameProjectEvents[0]?.[1].createdAt).toEqual(
      sameProjectRelation.createdAt,
    );
  });

  it("cascade delete versus moveTask serializes without deadlock via hierarchy lock", async () => {
    await resetTestDatabase();
    mocks.publishEvent.mockClear();
    mocks.cleanupAssetKeys.mockClear();

    const member = await createWorkspaceMember();
    const source = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Source",
      slug: "delete-vs-move-source",
    });
    const destination = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Destination",
      slug: "delete-vs-move-dest",
    });

    const root = await insertTask({
      projectId: source.project.id,
      title: "Root",
      number: 1,
      columnId: source.columns.todo.id,
    });
    const child = await insertTask({
      projectId: source.project.id,
      title: "Child",
      number: 2,
      columnId: source.columns.todo.id,
    });
    const grandchild = await insertTask({
      projectId: source.project.id,
      title: "Grandchild",
      number: 3,
      columnId: source.columns.todo.id,
    });
    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);

    const hierarchyIds = [root.id, child.id, grandchild.id];
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
      const deletePromise = deleteTask(root.id, member.user.id);

      await waitForBlockedHierarchyMutations(2);
      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
        member.workspace.id,
      ]);
      lockHeld = false;

      const results = await withTimeout(
        Promise.allSettled([movePromise, deletePromise]),
        10_000,
      );
      const [moveResult, deleteResult] = results;

      for (const result of results) {
        if (result.status === "rejected") {
          expect(isPostgresDeadlock(result.reason)).toBe(false);
        }
      }

      const remaining = await db
        .select({
          id: schema.taskTable.id,
          projectId: schema.taskTable.projectId,
          columnId: schema.taskTable.columnId,
          status: schema.taskTable.status,
        })
        .from(schema.taskTable)
        .where(inArray(schema.taskTable.id, hierarchyIds));

      if (deleteResult.status === "fulfilled") {
        // Delete removed the resolved hierarchy (move may have run first).
        expect(remaining).toHaveLength(0);
        if (moveResult.status === "rejected") {
          expect(moveResult.reason).toMatchObject({ status: 404 });
        }
      } else if (moveResult.status === "fulfilled") {
        // Move committed; delete failed without a partial cascade.
        expect(remaining).toHaveLength(3);
        const movedChild = remaining.find((task) => task.id === child.id);
        expect(movedChild).toMatchObject({
          projectId: destination.project.id,
        });
        expect(destinationColumnIds.has(movedChild?.columnId ?? "")).toBe(true);
        expect(sourceColumnIds.has(movedChild?.columnId ?? "")).toBe(false);

        expect(
          remaining
            .filter((task) => task.id !== child.id)
            .every((task) => task.projectId === source.project.id),
        ).toBe(true);
        expect(deleteResult.reason).toMatchObject({ status: 404 });
      } else {
        throw new Error(
          "Both move and delete rejected without a valid serialized outcome",
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
});
