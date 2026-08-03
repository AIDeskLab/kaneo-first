import { useQuery } from "@tanstack/react-query";
import getProjectGroups from "@/fetchers/project-group/get-project-groups";

function useGetProjectGroups(workspaceId: string) {
  return useQuery({
    queryFn: () => getProjectGroups(workspaceId),
    queryKey: ["project-groups", workspaceId],
    enabled: Boolean(workspaceId),
  });
}

export default useGetProjectGroups;
