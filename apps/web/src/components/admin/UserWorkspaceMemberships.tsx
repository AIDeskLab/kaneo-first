import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { InstanceUser, InstanceWorkspace } from "@/types/instance-user";

type Props = {
  user: InstanceUser;
  workspaces: InstanceWorkspace[];
  onRemove: (workspaceId: string) => void;
  onRoleChange: (workspaceId: string, role: string) => void;
};

export function UserWorkspaceMemberships({
  user,
  workspaces,
  onRemove,
  onRoleChange,
}: Props) {
  const { t } = useTranslation();
  if (user.workspaces.length === 0) {
    return (
      <span className="text-muted-foreground">
        {t("admin.users.noWorkspaces")}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {user.workspaces.map((workspace) => (
        <Badge key={workspace.id} variant="secondary" className="gap-1">
          <span>{workspace.name}</span>
          <select
            aria-label={`${workspace.name} ${t("admin.users.role")}`}
            className="bg-transparent text-xs"
            value={workspace.role}
            onChange={(event) => onRoleChange(workspace.id, event.target.value)}
          >
            {(
              workspaces.find((item) => item.id === workspace.id)?.roles ?? [
                { name: workspace.role },
              ]
            ).map((role) => (
              <option key={role.name} value={role.name}>
                {role.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onRemove(workspace.id)}
            aria-label={t("admin.users.removeFromWorkspace")}
          >
            ×
          </button>
        </Badge>
      ))}
    </div>
  );
}
