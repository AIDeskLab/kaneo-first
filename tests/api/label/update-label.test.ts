import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockExecute = vi.fn();
const mockRemoveGitHub = vi.fn();
const mockRemoveGitea = vi.fn();
const mockSyncGitHub = vi.fn();
const mockSyncGitea = vi.fn();
const mockTransaction = vi.fn();
const mockSelect = vi.fn();

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    query: {
      labelTable: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    select: (...args: unknown[]) => mockSelect(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
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

import updateLabel from "../../../apps/api/src/label/controllers/update-label";

const taskLabel = {
  id: "task-label-1",
  name: "bug",
  color: "#ff0000",
  workspaceId: "workspace-1",
  taskId: "task-1",
  source: "local",
};

const workspaceDefinition = {
  id: "label-ws-1",
  name: "bug",
  color: "#ff0000",
  workspaceId: "workspace-1",
  taskId: null,
  source: "local",
};

function taskSelectChain() {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue([
    {
      id: "task-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
    },
  ]);
  return chain;
}

function createTx({
  currentLabel = taskLabel,
  conflictingLabel = undefined as typeof taskLabel | undefined,
  affectedRows = [] as unknown[],
} = {}) {
  const txFindFirst = vi.fn();
  const txUpdate = vi.fn();
  const txSelect = vi.fn();

  let findFirstCall = 0;
  txFindFirst.mockImplementation(async () => {
    findFirstCall += 1;
    if (findFirstCall === 1) {
      return currentLabel;
    }
    if (conflictingLabel) {
      return conflictingLabel;
    }
    return undefined;
  });

  txSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(affectedRows),
        }),
      }),
    }),
  });

  txUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([
            { ...currentLabel, name: "defect", color: "#00ff00" },
          ]),
      }),
    }),
  });

  return {
    execute: mockExecute.mockResolvedValue(undefined),
    query: {
      labelTable: {
        findFirst: txFindFirst,
      },
    },
    select: txSelect,
    update: txUpdate,
  };
}

describe("updateLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(taskLabel);
    mockSelect.mockReturnValue(taskSelectChain());
    mockTransaction.mockImplementation(
      async (callback: (tx: ReturnType<typeof createTx>) => unknown) =>
        callback(createTx()),
    );
    mockRemoveGitHub.mockResolvedValue(undefined);
    mockRemoveGitea.mockResolvedValue(undefined);
    mockSyncGitHub.mockResolvedValue(undefined);
    mockSyncGitea.mockResolvedValue(undefined);
  });

  it("settles provider rename as detach-then-attach before local mutation", async () => {
    const callOrder: string[] = [];
    mockRemoveGitHub.mockImplementation(async () => {
      callOrder.push("remove-github");
    });
    mockRemoveGitea.mockImplementation(async () => {
      callOrder.push("remove-gitea");
    });
    mockSyncGitHub.mockImplementation(async () => {
      callOrder.push("sync-github");
    });
    mockSyncGitea.mockImplementation(async () => {
      callOrder.push("sync-gitea");
    });

    await updateLabel(taskLabel.id, "defect", "#00ff00");

    expect(callOrder).toEqual([
      "remove-github",
      "remove-gitea",
      "sync-github",
      "sync-gitea",
    ]);
    expect(mockRemoveGitHub).toHaveBeenCalledWith("task-1", "bug");
    expect(mockSyncGitHub).toHaveBeenCalledWith("task-1", "defect", "#00ff00");
  });

  it("preserves local state when provider rename fails", async () => {
    const tx = createTx();
    mockTransaction.mockImplementation(
      async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    );
    mockRemoveGitHub.mockRejectedValueOnce(new Error("github down"));

    await expect(
      updateLabel(taskLabel.id, "defect", "#00ff00"),
    ).rejects.toThrow("github down");
    expect(mockSyncGitHub).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects rename into an existing task label name before provider calls", async () => {
    const conflictingLabel = {
      id: "task-label-2",
      name: "defect",
      color: "#00ff00",
      workspaceId: "workspace-1",
      taskId: "task-1",
      source: "local",
    };
    mockTransaction.mockImplementation(
      async (callback: (tx: ReturnType<typeof createTx>) => unknown) =>
        callback(
          createTx({
            conflictingLabel,
          }),
        ),
    );

    await expect(
      updateLabel(taskLabel.id, "defect", "#00ff00"),
    ).rejects.toMatchObject({
      status: 409,
      message: "A task label with this name already exists",
    });
    expect(mockRemoveGitHub).not.toHaveBeenCalled();
    expect(mockRemoveGitea).not.toHaveBeenCalled();
    expect(mockSyncGitHub).not.toHaveBeenCalled();
    expect(mockSyncGitea).not.toHaveBeenCalled();
  });

  it("rejects stale concurrent rename before provider calls", async () => {
    mockTransaction.mockImplementation(
      async (callback: (tx: ReturnType<typeof createTx>) => unknown) =>
        callback(
          createTx({
            currentLabel: {
              ...taskLabel,
              name: "feature",
            },
          }),
        ),
    );

    await expect(
      updateLabel(taskLabel.id, "defect", "#00ff00"),
    ).rejects.toMatchObject({
      status: 404,
      message: "Label not found",
    });
    expect(mockRemoveGitHub).not.toHaveBeenCalled();
    expect(mockRemoveGitea).not.toHaveBeenCalled();
  });

  it("rejects workspace rename into an existing definition before provider calls", async () => {
    mockFindFirst.mockResolvedValue(workspaceDefinition);
    const conflictingDefinition = {
      id: "label-ws-2",
      name: "defect",
      color: "#00ff00",
      workspaceId: "workspace-1",
      taskId: null,
      source: "local",
    };
    mockTransaction.mockImplementation(
      async (callback: (tx: ReturnType<typeof createTx>) => unknown) =>
        callback(
          createTx({
            currentLabel: workspaceDefinition,
            conflictingLabel: conflictingDefinition,
          }),
        ),
    );

    await expect(
      updateLabel(workspaceDefinition.id, "defect", "#00ff00"),
    ).rejects.toMatchObject({
      status: 409,
      message: "A workspace label with this name already exists",
    });
    expect(mockRemoveGitHub).not.toHaveBeenCalled();
    expect(mockRemoveGitea).not.toHaveBeenCalled();
  });
});
