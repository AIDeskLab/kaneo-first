import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import useAddUserToWorkspace from "@/hooks/mutations/instance/use-add-user-to-workspace";
import useRemoveUserFromWorkspace from "@/hooks/mutations/instance/use-remove-user-from-workspace";
import useUpdateUserStatus from "@/hooks/mutations/instance/use-update-user-status";
import useUpdateUserWorkspaceRole from "@/hooks/mutations/instance/use-update-user-workspace-role";
import useInstanceUsers from "@/hooks/queries/instance/use-instance-users";
import useInstanceWorkspaces from "@/hooks/queries/instance/use-instance-workspaces";
import type { InstanceUser } from "@/types/instance-user";
import { UsersTable } from "./UsersTable";
import { UserWorkspaceAccessDialog } from "./UserWorkspaceAccessDialog";

// Load all instance users at once (matching the /members page pattern, which
// renders the full workspace member list without pagination controls).
const ALL_USERS_LIMIT = 1000;

export function UsersManagementPage() {
  const { t } = useTranslation();
  const [selectedUser, setSelectedUser] = useState<InstanceUser | null>(null);
  const { data, isLoading, isError, refetch } = useInstanceUsers(
    ALL_USERS_LIMIT,
    0,
  );
  const { data: workspaces = [] } = useInstanceWorkspaces();
  const add = useAddUserToWorkspace();
  const updateRole = useUpdateUserWorkspaceRole();
  const remove = useRemoveUserFromWorkspace();
  const status = useUpdateUserStatus();
  if (isLoading) return <p>{t("admin:users.loading")}</p>;
  if (isError || !data)
    return (
      <div className="space-y-2">
        <p className="text-destructive">{t("admin:users.loadError")}</p>
        <Button onClick={() => void refetch()}>
          {t("common:error.tryAgain")}
        </Button>
      </div>
    );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("admin:users.title")}</h1>
        <p className="text-muted-foreground">{t("admin:users.subtitle")}</p>
      </div>
      {data.users.length === 0 ? (
        <p>{t("admin:users.empty")}</p>
      ) : (
        <UsersTable
          users={data.users}
          workspaces={workspaces}
          onAdd={setSelectedUser}
          onRemove={(userId, workspaceId) =>
            remove.mutate({ userId, workspaceId })
          }
          onRoleChange={(userId, workspaceId, role) =>
            updateRole.mutate({ userId, workspaceId, role })
          }
          onStatusChange={(user) =>
            status.mutate({ userId: user.id, banned: !user.banned })
          }
        />
      )}
      <UserWorkspaceAccessDialog
        open={Boolean(selectedUser)}
        onOpenChange={(open) => !open && setSelectedUser(null)}
        workspaces={workspaces}
        isPending={add.isPending}
        onSubmit={(workspaceId, role) => {
          if (!selectedUser) return;
          add.mutate(
            { userId: selectedUser.id, workspaceId, role },
            { onSuccess: () => setSelectedUser(null) },
          );
        }}
      />
    </div>
  );
}
