import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InstanceUser, InstanceWorkspace } from "@/types/instance-user";
import { UserWorkspaceMemberships } from "./UserWorkspaceMemberships";

type Props = {
  users: InstanceUser[];
  workspaces: InstanceWorkspace[];
  onAdd: (user: InstanceUser) => void;
  onRemove: (userId: string, workspaceId: string) => void;
  onRoleChange: (userId: string, workspaceId: string, role: string) => void;
  onStatusChange: (user: InstanceUser) => void;
};

export function UsersTable({
  users,
  workspaces,
  onAdd,
  onRemove,
  onRoleChange,
  onStatusChange,
}: Props) {
  const { t } = useTranslation();
  const [removal, setRemoval] = useState<{
    userId: string;
    workspaceId: string;
  } | null>(null);
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("admin:users.name")}</TableHead>
            <TableHead>{t("admin:users.email")}</TableHead>
            <TableHead>{t("admin:users.globalRole")}</TableHead>
            <TableHead>{t("admin:users.banned")}</TableHead>
            <TableHead>{t("admin:users.workspaces")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>{user.name}</TableCell>
              <TableCell>{user.email}</TableCell>
              <TableCell>
                {user.role === "admin" ? (
                  <Badge>{t("admin:users.superUser")}</Badge>
                ) : (
                  (user.role ?? "—")
                )}
              </TableCell>
              <TableCell>
                <Badge variant={user.banned ? "destructive" : "secondary"}>
                  {user.banned
                    ? t("admin:users.bannedStatus")
                    : t("admin:users.active")}
                </Badge>
              </TableCell>
              <TableCell>
                <UserWorkspaceMemberships
                  user={user}
                  workspaces={workspaces}
                  onRemove={(workspaceId) =>
                    setRemoval({ userId: user.id, workspaceId })
                  }
                  onRoleChange={(workspaceId, role) =>
                    onRoleChange(user.id, workspaceId, role)
                  }
                />
              </TableCell>
              <TableCell className="space-x-2">
                <Button size="xs" variant="outline" onClick={() => onAdd(user)}>
                  {t("admin:users.addToWorkspace")}
                </Button>
                <Button
                  size="xs"
                  variant={user.banned ? "outline" : "destructive"}
                  onClick={() => onStatusChange(user)}
                >
                  {user.banned ? t("admin:users.unban") : t("admin:users.ban")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AlertDialog
        open={Boolean(removal)}
        onOpenChange={(open) => !open && setRemoval(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin:users.removeFromWorkspace")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin:users.removeConfirmation")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setRemoval(null)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removal) onRemove(removal.userId, removal.workspaceId);
                setRemoval(null);
              }}
            >
              {t("common:actions.remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
