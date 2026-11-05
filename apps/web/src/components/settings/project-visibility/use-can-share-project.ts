import { useWorkspacePermission } from "@/hooks/use-workspace-permission";

export function useCanShareProject() {
  const { canShareProjects } = useWorkspacePermission();
  return canShareProjects();
}
