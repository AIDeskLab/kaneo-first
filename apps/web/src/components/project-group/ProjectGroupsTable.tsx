import { useQueryClient } from "@tanstack/react-query";
import { EllipsisIcon, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useDeleteProjectGroup from "@/hooks/mutations/project-group/use-delete-project-group";
import useUpdateProjectGroup from "@/hooks/mutations/project-group/use-update-project-group";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";

type ProjectGroup = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  groups: ProjectGroup[];
  workspaceId: string;
};

export function ProjectGroupsTable({ groups, workspaceId }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const deleteMutation = useDeleteProjectGroup();
  const updateMutation = useUpdateProjectGroup();
  const [editGroup, setEditGroup] = useState<ProjectGroup | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteGroup, setDeleteGroup] = useState<ProjectGroup | null>(null);

  const handleEdit = (group: ProjectGroup) => {
    setEditGroup(group);
    setEditName(group.name);
  };

  const handleSaveEdit = async () => {
    if (!editGroup || !editName.trim()) return;
    await updateMutation.mutateAsync(
      { id: editGroup.id, name: editName },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: ["project-groups", workspaceId],
          });
          setEditGroup(null);
        },
      },
    );
  };

  const handleDelete = async () => {
    if (!deleteGroup) return;
    await deleteMutation.mutateAsync(deleteGroup.id, {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ["project-groups", workspaceId],
        });
        setDeleteGroup(null);
      },
    });
  };

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("project-groups:empty")}
      </p>
    );
  }

  return (
    <>
      <Table>
        <TableBody>
          {groups.map((group) => (
            <TableRow key={group.id}>
              <TableCell className="font-medium">{group.name}</TableCell>
              <TableCell className="text-right">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <EllipsisIcon className="h-4 w-4" />
                      </Button>
                    }
                  />
                  <MenuPopup align="end">
                    <MenuItem onClick={() => handleEdit(group)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      {t("common:actions.edit")}
                    </MenuItem>
                    <MenuItem onClick={() => setDeleteGroup(group)}>
                      <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                      {t("common:actions.delete")}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog
        open={Boolean(editGroup)}
        onOpenChange={(open) => !open && setEditGroup(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common:actions.edit")}</DialogTitle>
            <DialogDescription>{t("project-groups:name")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-group-name">
                {t("project-groups:name")}
              </Label>
              <Input
                id="edit-group-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditGroup(null)}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={updateMutation.isPending}
              >
                {t("common:actions.save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteGroup)}
        onOpenChange={(open) => !open && setDeleteGroup(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common:actions.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("common:confirmDelete", { name: deleteGroup?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>{t("common:actions.cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {t("common:actions.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
