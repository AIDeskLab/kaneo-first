import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteS3Object: vi.fn(async (_key: string) => {}),
  forceEnqueueFailure: false,
  cleanupAssetKeys: vi.fn(async () => {}),
}));

vi.mock("../../apps/api/src/storage/s3", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/api/src/storage/s3")>();
  return {
    ...actual,
    deleteS3Object: (...args: Parameters<typeof actual.deleteS3Object>) =>
      mocks.deleteS3Object(...args),
  };
});

vi.mock(
  "../../apps/api/src/storage/asset-cleanup-outbox",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../apps/api/src/storage/asset-cleanup-outbox")
      >();
    return {
      ...actual,
      enqueueAssetCleanupKeys: async (
        tx: Parameters<typeof actual.enqueueAssetCleanupKeys>[0],
        keys: string[],
      ) => {
        if (mocks.forceEnqueueFailure) {
          throw new Error("forced enqueue failure");
        }
        return actual.enqueueAssetCleanupKeys(tx, keys);
      },
    };
  },
);

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
import { assetCleanupOutboxTable } from "../../apps/api/src/database/schema";
import {
  enqueueAssetCleanupKeys,
  processAssetCleanupOutbox,
} from "../../apps/api/src/storage/asset-cleanup-outbox";
import deleteTask from "../../apps/api/src/task/controllers/delete-task";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const MINUTE_MS = 60 * 1000;

async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clearOutbox() {
  await db.delete(assetCleanupOutboxTable);
}

async function listOutbox() {
  return db.select().from(assetCleanupOutboxTable);
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

describe("API integration: task asset cleanup outbox", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await clearOutbox();
    mocks.forceEnqueueFailure = false;
    mocks.deleteS3Object.mockReset();
    mocks.deleteS3Object.mockImplementation(async () => {});
    mocks.cleanupAssetKeys.mockReset();
    mocks.cleanupAssetKeys.mockImplementation(async () => {});
  });

  it("rolls back task deletion when outbox enqueue fails, and stores unique keys on success", async () => {
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

    const rootKey = `tasks/${root.id}/root.png`;
    const childKey = `tasks/${child.id}/child.png`;
    await insertAsset({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: root.id,
      objectKey: rootKey,
    });
    await insertAsset({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: child.id,
      objectKey: childKey,
    });

    mocks.forceEnqueueFailure = true;
    await expect(deleteTask(root.id, member.user.id)).rejects.toThrow(
      "forced enqueue failure",
    );

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
    expect(await listOutbox()).toHaveLength(0);

    mocks.forceEnqueueFailure = false;
    await deleteTask(root.id, member.user.id);

    const outbox = await listOutbox();
    expect(outbox.map((row) => row.objectKey).sort()).toEqual(
      [rootKey, childKey].sort(),
    );
  });

  it("on processor success deletes the S3 object and removes the outbox row", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    const objectKey = "workspace/ws/project/p/task/t/a.png";

    await db
      .insert(assetCleanupOutboxTable)
      .values({ objectKey, nextAttemptAt: now });

    const result = await processAssetCleanupOutbox({ now });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(mocks.deleteS3Object).toHaveBeenCalledTimes(1);
    expect(mocks.deleteS3Object).toHaveBeenCalledWith(objectKey);
    expect(await listOutbox()).toHaveLength(0);
  });

  it("on S3 failure keeps the row, increments attempts, stores error and future nextAttemptAt", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    const objectKey = "workspace/ws/project/p/task/t/fail.png";

    await db
      .insert(assetCleanupOutboxTable)
      .values({ objectKey, nextAttemptAt: now });
    mocks.deleteS3Object.mockRejectedValueOnce(new Error("S3 unavailable"));

    const result = await processAssetCleanupOutbox({ now });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(mocks.deleteS3Object).toHaveBeenCalledWith(objectKey);

    const [row] = await listOutbox();
    expect(row).toMatchObject({
      objectKey,
      attempts: 1,
      lastError: "S3 unavailable",
    });
    expect(row.nextAttemptAt.getTime()).toBe(
      now.getTime() + 2 ** 1 * MINUTE_MS,
    );
  });

  it("later succeeds and removes a previously failed outbox row", async () => {
    const failAt = new Date("2026-01-15T12:00:00.000Z");
    const retryAt = new Date("2026-01-15T12:05:00.000Z");
    const objectKey = "workspace/ws/project/p/task/t/retry.png";

    await db
      .insert(assetCleanupOutboxTable)
      .values({ objectKey, nextAttemptAt: failAt });
    mocks.deleteS3Object.mockRejectedValueOnce(new Error("transient S3 error"));

    await processAssetCleanupOutbox({ now: failAt });

    const [failed] = await listOutbox();
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(failAt.getTime());

    mocks.deleteS3Object.mockResolvedValueOnce(undefined);
    const result = await processAssetCleanupOutbox({ now: retryAt });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(mocks.deleteS3Object).toHaveBeenLastCalledWith(objectKey);
    expect(await listOutbox()).toHaveLength(0);
  });

  it("duplicate key enqueue produces a single outbox row", async () => {
    const objectKey = "workspace/ws/project/p/task/t/dup.png";

    await db.transaction(async (tx) => {
      await enqueueAssetCleanupKeys(tx, [
        objectKey,
        ` ${objectKey} `,
        objectKey,
      ]);
      await enqueueAssetCleanupKeys(tx, [objectKey, ""]);
    });

    const outbox = await listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.objectKey).toBe(objectKey);
  });

  it("two concurrent processors never process the same row simultaneously via SKIP LOCKED", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    const objectKey = "workspace/ws/project/p/task/t/locked.png";

    await db
      .insert(assetCleanupOutboxTable)
      .values({ objectKey, nextAttemptAt: now });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;

    mocks.deleteS3Object.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
    });

    const first = processAssetCleanupOutbox({ now });
    await waitUntil(() => inFlight === 1, "first processor to hold the row");

    const second = await processAssetCleanupOutbox({ now });
    expect(second).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(maxInFlight).toBe(1);

    release();
    const firstResult = await first;
    expect(firstResult).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(mocks.deleteS3Object).toHaveBeenCalledTimes(1);
    expect(await listOutbox()).toHaveLength(0);
  });

  it("empty queue is a no-op and a not-yet-due failed row does not block other due rows", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z");

    const empty = await processAssetCleanupOutbox({ now });
    expect(empty).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(mocks.deleteS3Object).not.toHaveBeenCalled();

    const dueKey = "workspace/ws/project/p/task/t/due.png";
    const blockedKey = "workspace/ws/project/p/task/t/blocked.png";

    await db.insert(assetCleanupOutboxTable).values([
      {
        objectKey: blockedKey,
        attempts: 1,
        lastError: "previous failure",
        nextAttemptAt: new Date(now.getTime() + 60 * MINUTE_MS),
      },
      {
        objectKey: dueKey,
        nextAttemptAt: now,
      },
    ]);

    const result = await processAssetCleanupOutbox({ now });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(mocks.deleteS3Object).toHaveBeenCalledTimes(1);
    expect(mocks.deleteS3Object).toHaveBeenCalledWith(dueKey);

    const remaining = await listOutbox();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.objectKey).toBe(blockedKey);
  });
});
