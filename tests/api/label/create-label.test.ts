import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockPublishEvent = vi.fn();
const mockSyncGitHub = vi.fn();
const mockSyncGitea = vi.fn();

function selectTask(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

const tx = {
  execute: (...args: unknown[]) => mockExecute(...args),
  select: vi.fn(),
  insert: (...args: unknown[]) => mockInsert(...args),
  query: {
    labelTable: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
};

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    transaction: (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
  },
}));

vi.mock("../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

vi.mock(
  "../../../apps/api/src/plugins/github/utils/sync-label-to-github",
  () => ({
    syncLabelToGitHub: (...args: unknown[]) => mockSyncGitHub(...args),
  }),
);

vi.mock(
  "../../../apps/api/src/plugins/gitea/utils/sync-label-to-gitea",
  () => ({
    syncLabelToGitea: (...args: unknown[]) => mockSyncGitea(...args),
  }),
);

import createLabel from "../../../apps/api/src/label/controllers/create-label";

function insertResult(row: unknown) {
  const returning = vi.fn().mockResolvedValue(row ? [row] : []);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  return { values: vi.fn(() => ({ onConflictDoNothing })) };
}

describe("createLabel provider settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
    mockFindFirst.mockResolvedValue(undefined);
    mockSyncGitHub.mockResolvedValue(undefined);
    mockSyncGitea.mockResolvedValue(undefined);
  });

  it("preserves local state and emits no event when task provider attach fails", async () => {
    tx.select.mockReturnValue(
      selectTask([
        { id: "task-1", projectId: "project-1", workspaceId: "workspace-1" },
      ]),
    );
    mockSyncGitHub.mockRejectedValue(new Error("github down"));

    await expect(
      createLabel("Bug", "red", "task-1", "workspace-1", "user-1"),
    ).rejects.toThrow("github down");

    expect(mockExecute).toHaveBeenCalledOnce();
    expect(mockSyncGitea).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it("takes the workspace label lock for definition creation", async () => {
    const label = {
      id: "label-1",
      name: "Bug",
      color: "red",
      taskId: null,
      workspaceId: "workspace-1",
    };
    mockInsert.mockReturnValue(insertResult(label));

    await expect(
      createLabel("Bug", "red", undefined, "workspace-1", "user-1"),
    ).resolves.toEqual(label);

    expect(mockExecute).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});
