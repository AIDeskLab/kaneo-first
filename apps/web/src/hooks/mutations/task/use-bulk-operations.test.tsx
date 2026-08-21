import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bulkOperation from "@/fetchers/task/bulk-operation";
import { useBulkOperations } from "./use-bulk-operations";

vi.mock("@/fetchers/task/bulk-operation", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

const mockedBulkOperation = vi.mocked(bulkOperation);

const COMMON_INVALIDATION_PREFIXES = [
  "tasks",
  "task",
  "projects",
  "task-relations",
  "notifications",
] as const;

function createTestEnv() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return { queryClient, invalidateSpy, Wrapper };
}

function expectCommonPrefixInvalidation(
  invalidateSpy: ReturnType<typeof vi.spyOn>,
) {
  const predicateCall = invalidateSpy.mock.calls.find((call: unknown[]) => {
    const filters = call[0] as {
      predicate?: (query: { queryKey: unknown[] }) => boolean;
    };
    return typeof filters?.predicate === "function";
  });

  expect(predicateCall).toBeDefined();

  const filters = predicateCall?.[0] as {
    predicate: (query: { queryKey: unknown[] }) => boolean;
  };

  for (const prefix of COMMON_INVALIDATION_PREFIXES) {
    expect(filters.predicate({ queryKey: [prefix] })).toBe(true);
  }

  expect(filters.predicate({ queryKey: ["labels"] })).toBe(false);
  expect(filters.predicate({ queryKey: ["unrelated"] })).toBe(false);
}

describe("useBulkOperations", () => {
  beforeEach(() => {
    mockedBulkOperation.mockReset();
    mockedBulkOperation.mockResolvedValue({ success: true, updatedCount: 0 });
  });

  it("bulkDelete issues exactly one bulk call with operation delete for all task ids", async () => {
    const { Wrapper } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    const taskIds = ["task-1", "task-2", "task-3"];
    await result.current.bulkDelete(taskIds);

    expect(mockedBulkOperation).toHaveBeenCalledTimes(1);
    expect(mockedBulkOperation).toHaveBeenCalledWith({
      taskIds,
      operation: "delete",
    });
  });

  it("bulkArchive issues exactly one bulk call with updateStatus archived", async () => {
    const { Wrapper } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    const taskIds = ["task-1", "task-2"];
    await result.current.bulkArchive(taskIds);

    expect(mockedBulkOperation).toHaveBeenCalledTimes(1);
    expect(mockedBulkOperation).toHaveBeenCalledWith({
      taskIds,
      operation: "updateStatus",
      value: "archived",
    });
  });

  it("selecting a parent and its child issues a single bulk call", async () => {
    const { Wrapper } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    const parentId = "parent-task";
    const childId = "child-task";
    await result.current.bulkDelete([parentId, childId]);

    expect(mockedBulkOperation).toHaveBeenCalledTimes(1);
    expect(mockedBulkOperation).toHaveBeenCalledWith({
      taskIds: [parentId, childId],
      operation: "delete",
    });
  });

  it("bulkChangeStatus issues exactly one bulk call with the status payload", async () => {
    const { Wrapper } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    const taskIds = ["task-1", "task-2"];
    await result.current.bulkChangeStatus({ taskIds, status: "done" });

    expect(mockedBulkOperation).toHaveBeenCalledTimes(1);
    expect(mockedBulkOperation).toHaveBeenCalledWith({
      taskIds,
      operation: "updateStatus",
      value: "done",
    });
  });

  it.each([
    {
      name: "bulkDelete",
      run: (ops: ReturnType<typeof useBulkOperations>) =>
        ops.bulkDelete(["task-1"]),
    },
    {
      name: "bulkArchive",
      run: (ops: ReturnType<typeof useBulkOperations>) =>
        ops.bulkArchive(["task-1"]),
    },
    {
      name: "bulkChangeStatus",
      run: (ops: ReturnType<typeof useBulkOperations>) =>
        ops.bulkChangeStatus({ taskIds: ["task-1"], status: "in-progress" }),
    },
  ])(
    "$name success invalidates tasks, task, projects, task-relations, notifications",
    async ({ run }) => {
      const { Wrapper, invalidateSpy } = createTestEnv();
      const { result } = renderHook(() => useBulkOperations(), {
        wrapper: Wrapper,
      });

      await run(result.current);

      expectCommonPrefixInvalidation(invalidateSpy);
      expect(invalidateSpy).not.toHaveBeenCalledWith({
        queryKey: ["labels"],
      });
    },
  );

  it("bulkAddLabel success invalidates common prefixes and labels", async () => {
    const { Wrapper, invalidateSpy } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    const taskIds = ["task-1"];
    await result.current.bulkAddLabel({ taskIds, labelId: "label-1" });

    expect(mockedBulkOperation).toHaveBeenCalledTimes(1);
    expect(mockedBulkOperation).toHaveBeenCalledWith({
      taskIds,
      operation: "addLabel",
      value: "label-1",
    });

    expectCommonPrefixInvalidation(invalidateSpy);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["labels"] });
  });

  it("rejected bulkOperation rejects mutateAsync with the same error and skips success invalidations", async () => {
    const error = new Error("bulk operation failed");
    mockedBulkOperation.mockRejectedValueOnce(error);

    const { Wrapper, invalidateSpy } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    await expect(result.current.bulkDelete(["task-1"])).rejects.toBe(error);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("bulkArchivePending is true during a deferred archive and false after resolve", async () => {
    let resolveOperation!: (
      value:
        | { success: boolean; updatedCount: number }
        | PromiseLike<{ success: boolean; updatedCount: number }>,
    ) => void;
    mockedBulkOperation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOperation = resolve;
        }),
    );

    const { Wrapper } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    expect(result.current.bulkArchivePending).toBe(false);

    let archivePromise!: Promise<unknown>;
    act(() => {
      archivePromise = result.current.bulkArchive(["task-1"]);
    });

    await waitFor(() => {
      expect(result.current.bulkArchivePending).toBe(true);
    });

    await act(async () => {
      resolveOperation({ success: true, updatedCount: 0 });
      await archivePromise;
    });

    await waitFor(() => {
      expect(result.current.bulkArchivePending).toBe(false);
    });
  });

  it("bulkArchivePending becomes false after a deferred archive rejects", async () => {
    let rejectOperation!: (reason?: unknown) => void;
    mockedBulkOperation.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOperation = reject;
        }),
    );

    const { Wrapper } = createTestEnv();
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: Wrapper,
    });

    let archivePromise!: Promise<unknown>;
    act(() => {
      archivePromise = result.current.bulkArchive(["task-1"]);
    });

    await waitFor(() => {
      expect(result.current.bulkArchivePending).toBe(true);
    });

    const error = new Error("archive failed");
    await act(async () => {
      rejectOperation(error);
      await expect(archivePromise).rejects.toBe(error);
    });

    await waitFor(() => {
      expect(result.current.bulkArchivePending).toBe(false);
    });
  });
});
