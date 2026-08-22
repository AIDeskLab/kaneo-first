import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  resolveTaskHierarchy,
  WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE,
} from "../../apps/api/src/task/controllers/task-cascade";
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

describe("task hierarchy resolver", () => {
  it("includes roots, follows only subtask edges, and dedupes multi-root input", async () => {
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
    const grandchild = await insertTask({
      projectId: project.id,
      title: "Grandchild",
      number: 3,
      columnId: columns.todo.id,
    });
    const unrelated = await insertTask({
      projectId: project.id,
      title: "Unrelated",
      number: 4,
      columnId: columns.todo.id,
    });
    const blocked = await insertTask({
      projectId: project.id,
      title: "Blocked via non-subtask",
      number: 5,
      columnId: columns.todo.id,
    });

    await insertSubtask(root.id, child.id);
    await insertSubtask(child.id, grandchild.id);
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: root.id,
      targetTaskId: blocked.id,
      relationType: "blocks",
    });

    const resolved = await db.transaction(async (tx) =>
      resolveTaskHierarchy(tx, member.workspace.id, [
        root.id,
        child.id,
        root.id,
      ]),
    );

    expect(resolved.map((task) => task.id)).toEqual([
      root.id,
      child.id,
      grandchild.id,
    ]);
    expect(resolved.map((task) => task.id)).not.toContain(unrelated.id);
    expect(resolved.map((task) => task.id)).not.toContain(blocked.id);
    expect(WORKSPACE_TASK_HIERARCHY_LOCK_NAMESPACE).toBe(1540);
  });

  it("terminates on corrupted cycles and fails closed on cross-workspace edges", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember();
    const outsider = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const foreign = await createProjectFixture({
      workspaceId: outsider.workspace.id,
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
    const foreignTask = await insertTask({
      projectId: foreign.project.id,
      title: "Foreign",
      number: 1,
      columnId: foreign.columns.todo.id,
    });

    await insertSubtask(a.id, b.id);
    // Corrupted cycle: B → A
    await insertSubtask(b.id, a.id);

    const cycled = await db.transaction(async (tx) =>
      resolveTaskHierarchy(tx, member.workspace.id, [a.id]),
    );
    expect(cycled.map((task) => task.id).sort()).toEqual([a.id, b.id].sort());

    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: a.id,
      targetTaskId: foreignTask.id,
      relationType: "subtask",
    });

    await expect(
      db.transaction(async (tx) =>
        resolveTaskHierarchy(tx, member.workspace.id, [a.id]),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const foreignEdge = await db.query.taskRelationTable.findFirst({
      where: and(
        eq(schema.taskRelationTable.sourceTaskId, a.id),
        eq(schema.taskRelationTable.targetTaskId, foreignTask.id),
      ),
    });
    expect(foreignEdge).toBeDefined();
  });
});
