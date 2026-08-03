import { useMutation } from "@tanstack/react-query";
import updateProjectGroup from "@/fetchers/project-group/update-project-group";

function useUpdateProjectGroup() {
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      updateProjectGroup(id, name),
  });
}

export default useUpdateProjectGroup;
