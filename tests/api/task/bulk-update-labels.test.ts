import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.fn();
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockDelete = vi.fn();
const mockInsert = vi.fn();
const mockPublishEvent = vi.fn();
const mockRemoveGitHub = vi.fn();
const mockRemoveGitea = vi.fn();
const mockSyncGitHub = vi.fn();
const mockSyncGitea = vi.fn();
const mockTransaction = vi.fn();

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
    query: {
      labelTable: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock("../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));
vi.mock(
  "../../../apps/api/src/plugins/github/utils/sync-label-to-github",
  () => ({
    removeLabelFromGitHub: (...args: unknown[]) => mockRemoveGitHub(...args),
    syncLabelToGitHub: (...args: unknown[]) => mockSyncGitHub(...args),
  }),
);
vi.mock(
  "../../../apps/api/src/plugins/gitea/utils/sync-label-to-gitea",
  () => ({
    removeLabelFromGitea: (...args: unknown[]) => mockRemoveGitea(...args),
    syncLabelToGitea: (...args: unknown[]) => mockSyncGitea(...args),
  }),
);

import bulkUpdateTasks from "../../../apps/api/src/task/controllers/bulk-update-tasks";

const task = {
  id: "task-1",
  title: "Task",
  projectId: "project-1",
  userId: "user-1",
  startDate: null,
  dueDate: null,
  workspaceId: "workspace-1",
};
const taskLabel = {
  id: "task-label-1",
  name: "bug",
  color: "red",
  taskId: task.id,
  workspaceId: task.workspaceId,
};

function taskSelectChain() {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockResolvedValue([task]);
  return chain;
}

function membershipSelectChain() {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue([{ id: "membership-1" }]);
  return chain;
}

describe("bulkUpdateTasks removeLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect
      .mockReturnValueOnce(taskSelectChain())
      .mockReturnValueOnce(membershipSelectChain());
    mockFindFirst.mockResolvedValue({ ...taskLabel, taskId: null });
    mockFindMany.mockResolvedValue([taskLabel]);
    mockRemoveGitHub.mockResolvedValue(undefined);
    mockRemoveGitea.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          execute: vi.fn().mockResolvedValue(undefined),
          query: {
            labelTable: {
              findFirst: (...args: unknown[]) => mockFindFirst(...args),
              findMany: (...args: unknown[]) => mockFindMany(...args),
            },
          },
          insert: (...args: unknown[]) => mockInsert(...args),
          delete: (...args: unknown[]) => mockDelete(...args),
        }),
    );
  });

  it("preserves local labels and emits no event when provider removal fails", async () => {
    mockRemoveGitHub.mockRejectedValue(new Error("github down"));

    await expect(
      bulkUpdateTasks({
        taskIds: [task.id],
        operation: "removeLabel",
        value: "workspace-label-1",
        userId: "user-1",
      }),
    ).rejects.toThrow("github down");
    expect(mockFindMany).toHaveBeenCalledOnce();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it("does not insert or publish when bulk provider attachment fails", async () => {
    const definition = { ...taskLabel, taskId: null };
    mockFindFirst
      .mockResolvedValueOnce(definition)
      .mockResolvedValueOnce(definition)
      .mockResolvedValueOnce(undefined); // existing assignment check returns undefined
    mockSyncGitHub.mockRejectedValue(new Error("github attach failed"));
    mockSyncGitea.mockResolvedValue(undefined);

    await expect(
      bulkUpdateTasks({
        taskIds: [task.id],
        operation: "addLabel",
        value: "workspace-label-1",
        userId: "user-1",
      }),
    ).rejects.toThrow("github attach failed");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });
});
