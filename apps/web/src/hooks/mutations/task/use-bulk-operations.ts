import { useMutation, useQueryClient } from "@tanstack/react-query";
import bulkOperation from "@/fetchers/task/bulk-operation";

const COMMON_QUERY_PREFIXES = [
  "tasks",
  "task",
  "projects",
  "task-relations",
  "notifications",
] as const;

export function useBulkOperations() {
  const queryClientRef = useQueryClient();

  const invalidateCommon = () => {
    queryClientRef.invalidateQueries({
      predicate: (query) => {
        const prefix = query.queryKey[0];
        return (
          typeof prefix === "string" &&
          (COMMON_QUERY_PREFIXES as readonly string[]).includes(prefix)
        );
      },
    });
  };

  const bulkDelete = useMutation({
    mutationFn: async (taskIds: string[]) => {
      return await bulkOperation({
        taskIds,
        operation: "delete",
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkArchive = useMutation({
    mutationFn: async (taskIds: string[]) => {
      return await bulkOperation({
        taskIds,
        operation: "updateStatus",
        value: "archived",
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkChangeStatus = useMutation({
    mutationFn: async ({
      taskIds,
      status,
    }: {
      taskIds: string[];
      status: string;
    }) => {
      return await bulkOperation({
        taskIds,
        operation: "updateStatus",
        value: status,
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkAssign = useMutation({
    mutationFn: async ({
      taskIds,
      userId,
    }: {
      taskIds: string[];
      userId: string;
    }) => {
      await bulkOperation({
        taskIds,
        operation: "updateAssignee",
        value: userId,
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkMoveToBacklog = useMutation({
    mutationFn: async (taskIds: string[]) => {
      await bulkOperation({
        taskIds,
        operation: "updateStatus",
        value: "planned",
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkMoveToBoard = useMutation({
    mutationFn: async ({
      taskIds,
      status,
    }: {
      taskIds: string[];
      status: string;
    }) => {
      await bulkOperation({
        taskIds,
        operation: "updateStatus",
        value: status,
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkPriority = useMutation({
    mutationFn: async ({
      taskIds,
      priority,
    }: {
      taskIds: string[];
      priority: string;
    }) => {
      await bulkOperation({
        taskIds,
        operation: "updatePriority",
        value: priority,
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkAddLabel = useMutation({
    mutationFn: async ({
      taskIds,
      labelId,
    }: {
      taskIds: string[];
      labelId: string;
    }) => {
      await bulkOperation({
        taskIds,
        operation: "addLabel",
        value: labelId,
      });
    },
    onSuccess: () => {
      invalidateCommon();
      queryClientRef.invalidateQueries({ queryKey: ["labels"] });
    },
  });

  const bulkDueDate = useMutation({
    mutationFn: async ({
      taskIds,
      dueDate,
    }: {
      taskIds: string[];
      dueDate: string | null;
    }) => {
      await bulkOperation({
        taskIds,
        operation: "updateDueDate",
        value: dueDate,
      });
    },
    onSuccess: invalidateCommon,
  });

  return {
    bulkDelete: bulkDelete.mutateAsync,
    bulkArchive: bulkArchive.mutateAsync,
    bulkChangeStatus: bulkChangeStatus.mutateAsync,
    bulkAssign: bulkAssign.mutateAsync,
    bulkMoveToBacklog: bulkMoveToBacklog.mutateAsync,
    bulkMoveToBoard: bulkMoveToBoard.mutateAsync,
    bulkPriority: bulkPriority.mutateAsync,
    bulkAddLabel: bulkAddLabel.mutateAsync,
    bulkDueDate: bulkDueDate.mutateAsync,
    bulkArchivePending: bulkArchive.isPending,
  };
}
