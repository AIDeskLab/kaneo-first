import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bulkOperation from "@/fetchers/task/bulk-operation";
import { useBulkOperations } from "./use-bulk-operations";

vi.mock("@/fetchers/task/bulk-operation", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

const mockedBulkOperation = vi.mocked(bulkOperation);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useBulkOperations", () => {
  beforeEach(() => {
    mockedBulkOperation.mockClear();
  });

  it("bulkDelete issues exactly one bulk call with operation delete for all task ids", async () => {
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: createWrapper(),
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
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: createWrapper(),
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
    const { result } = renderHook(() => useBulkOperations(), {
      wrapper: createWrapper(),
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
});
