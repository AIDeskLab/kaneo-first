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

import db, { schema } from "../../apps/api/src/database";
import bulkUpdateTasks from "../../apps/api/src/task/controllers/bulk-update-tasks";
import moveTask from "../../apps/api/src/task/controllers/move-task";
import { updateTaskHierarchyStatus } from "../../apps/api/src/task/controllers/update-task-hierarchy-status";
import updateTaskStatus from "../../apps/api/src/task/controllers/update-task-status";
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

    const after = await loadTasks([root.id, child.id]);
    expect(after).toEqual(
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
    expect(mocks.publishEvent).not.toHaveBeenCalled();

    await expect(
      db.transaction(async (tx) =>
        updateTaskHierarchyStatus(tx, member.workspace.id, [root.id], "special"),
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
        expect(hierarchyResult.changedTasks.map((task) => task.id).sort()).toEqual(
          [root.id, child.id, grandchild.id, sibling.id].sort(),
        );
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
});
