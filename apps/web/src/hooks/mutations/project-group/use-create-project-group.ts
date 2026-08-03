import { useMutation } from "@tanstack/react-query";
import createProjectGroup from "@/fetchers/project-group/create-project-group";

function useCreateProjectGroup(workspaceId: string) {
  return useMutation({
    mutationFn: (name: string) => createProjectGroup(workspaceId, name),
  });
}

export default useCreateProjectGroup;
