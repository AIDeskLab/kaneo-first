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
      <div className="border border-border rounded-[var(--radius)] overflow-hidden">
        <Table>
          <TableHeader className="pointer-events-none">
            <TableRow className="border-b-0">
              <TableHead className="ps-6 py-3 text-sm">
                {t("admin:users.name")}
              </TableHead>
              <TableHead className="py-3 text-sm">
                {t("admin:users.email")}
              </TableHead>
              <TableHead className="py-3 text-sm">
                {t("admin:users.globalRole")}
              </TableHead>
              <TableHead className="py-3 text-sm">
                {t("admin:users.banned")}
              </TableHead>
              <TableHead className="py-3 text-sm">
                {t("admin:users.workspaces")}
              </TableHead>
              <TableHead className="pe-6 py-3 text-sm" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id} className="border-b-0">
                <TableCell className="ps-6 py-3 text-sm">{user.name}</TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground">
                  {user.email}
                </TableCell>
                <TableCell className="py-3 text-sm">
                  {user.role === "admin" ? (
                    <Badge>{t("admin:users.superUser")}</Badge>
                  ) : (
                    (user.role ?? "—")
                  )}
                </TableCell>
                <TableCell className="py-3 text-sm">
                  <Badge variant={user.banned ? "destructive" : "secondary"}>
                    {user.banned
                      ? t("admin:users.bannedStatus")
                      : t("admin:users.active")}
                  </Badge>
                </TableCell>
                <TableCell className="py-3 text-sm">
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
                <TableCell className="pe-6 py-3 text-right space-x-2 text-sm">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onAdd(user)}
                  >
                    {t("admin:users.addToWorkspace")}
                  </Button>
                  <Button
                    size="xs"
                    variant={user.banned ? "outline" : "destructive"}
                    onClick={() => onStatusChange(user)}
                  >
                    {user.banned
                      ? t("admin:users.unban")
                      : t("admin:users.ban")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
