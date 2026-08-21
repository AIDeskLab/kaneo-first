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

import db, { schema } from "../../apps/api/src/database";
import bulkUpdateTasks from "../../apps/api/src/task/controllers/bulk-update-tasks";
import deleteTask from "../../apps/api/src/task/controllers/delete-task";
import { deleteTaskHierarchy } from "../../apps/api/src/task/controllers/delete-task-hierarchy";
import getTask from "../../apps/api/src/task/controllers/get-task";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

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

    const deletedTaskEvents = mocks.publishEvent.mock.calls.filter(
      ([type]) => type === "task.deleted",
    );
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

    expect(mocks.publishEvent).not.toHaveBeenCalled();
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
});
