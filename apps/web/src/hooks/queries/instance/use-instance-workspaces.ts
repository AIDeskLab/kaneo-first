import { useQuery } from "@tanstack/react-query";
import getInstanceWorkspaces from "@/fetchers/instance/get-instance-workspaces";

export default function useInstanceWorkspaces() {
  return useQuery({
    queryKey: ["instance", "workspaces"],
    queryFn: getInstanceWorkspaces,
  });
}
