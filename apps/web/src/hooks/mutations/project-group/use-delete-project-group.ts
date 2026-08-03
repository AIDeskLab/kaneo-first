import { useMutation } from "@tanstack/react-query";
import deleteProjectGroup from "@/fetchers/project-group/delete-project-group";

function useDeleteProjectGroup() {
  return useMutation({
    mutationFn: (id: string) => deleteProjectGroup(id),
  });
}

export default useDeleteProjectGroup;
