import { workspaceCapabilities } from "@kaneo/permissions";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import getMyCapabilities from "@/fetchers/workspace/get-my-capabilities";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { useGetActiveWorkspaceUser } from "@/hooks/queries/workspace-users/use-active-workspace-user";

export type PermissionLevel = "owner" | "admin" | "member";

type CapabilityName = keyof typeof workspaceCapabilities;
type CapabilityMap = Record<CapabilityName, boolean>;
type CanHelpers = {
  [K in CapabilityName as `can${Capitalize<K>}`]: () => boolean;
} & {
  canManageTasks: () => boolean;
  canManageLabels: () => boolean;
};

function emptyCapabilityMap(): CapabilityMap {
  const out = {} as CapabilityMap;
  for (const key of Object.keys(workspaceCapabilities) as CapabilityName[]) {
    out[key] = false;
  }
  return out;
}

function helperName(capability: string) {
  return `can${capability.charAt(0).toUpperCase()}${capability.slice(1)}`;
}

export function useWorkspacePermission() {
  const { data: activeWorkspace } = useActiveWorkspace();
  const { data: activeMember } = useGetActiveWorkspaceUser();
  const workspaceId = activeWorkspace?.id;
  const role = activeMember?.role as string | undefined;

  const {
    data: capabilities,
    isLoading,
    isFetching,
    isError,
  } = useQuery({
    queryKey: ["workspace-capabilities", workspaceId, role],
    enabled: Boolean(workspaceId),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const result = (await getMyCapabilities(workspaceId ?? "")) as Record<
        string,
        unknown
      > | null;
      const map = emptyCapabilityMap();
      if (result && typeof result === "object") {
        for (const key of Object.keys(
          workspaceCapabilities,
        ) as CapabilityName[]) {
          map[key] = result[key] === true;
        }
      }
      return map;
    },
  });

  const can: CapabilityMap = capabilities ?? emptyCapabilityMap();

  const helpers = useMemo(() => {
    const named = {} as CanHelpers;
    const helpers = named as Record<string, () => boolean>;
    for (const key of Object.keys(workspaceCapabilities) as CapabilityName[]) {
      helpers[helperName(key)] = () => can[key];
    }
    // Archive and other task-management UI still asks for the combined gate.
    named.canManageTasks = () => can.updateTasks && can.deleteTasks;
    named.canManageLabels = () =>
      can.createLabels && can.updateLabels && can.deleteLabels;
    return named;
  }, [can]);

  return {
    ...helpers,
    workspace: activeWorkspace,
    member: activeMember,
    role,
    isOwner: role === "owner",
    isAdmin: role === "owner" || role === "admin",
    isCheckingPermissions: Boolean(workspaceId) && isLoading && !isError,
    isRefetchingPermissions: isFetching,
  };
}
