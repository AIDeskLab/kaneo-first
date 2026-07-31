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

export function UsersManagementPage() {
  const { t } = useTranslation();
  const [selectedUser, setSelectedUser] = useState<InstanceUser | null>(null);
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, refetch } = useInstanceUsers(limit, offset);
  const { data: workspaces = [] } = useInstanceWorkspaces();
  const add = useAddUserToWorkspace();
  const updateRole = useUpdateUserWorkspaceRole();
  const remove = useRemoveUserFromWorkspace();
  const status = useUpdateUserStatus();
  if (isLoading) return <p>{t("admin.users.loading")}</p>;
  if (isError || !data)
    return (
      <div className="space-y-2">
        <p className="text-destructive">{t("admin.users.loadError")}</p>
        <Button onClick={() => void refetch()}>
          {t("common:error.tryAgain")}
        </Button>
      </div>
    );
  const total = data.total ?? 0;
  const pageStart = offset + 1;
  const pageEnd = offset + data.users.length;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("admin.users.title")}</h1>
        <p className="text-muted-foreground">{t("admin.users.subtitle")}</p>
      </div>
      {data.users.length === 0 ? (
        <p>{t("admin.users.empty")}</p>
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
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {total > 0
            ? t("admin.users.pagination", {
                start: pageStart,
                end: pageEnd,
                total,
              })
            : ""}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!hasPrev}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            {t("admin.users.prev")}
          </Button>
          <Button
            variant="outline"
            disabled={!hasNext}
            onClick={() => setOffset(offset + limit)}
          >
            {t("admin.users.next")}
          </Button>
        </div>
      </div>
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
