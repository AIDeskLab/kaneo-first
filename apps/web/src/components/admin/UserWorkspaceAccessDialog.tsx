import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { InstanceWorkspace } from "@/types/instance-user";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: InstanceWorkspace[];
  onSubmit: (workspaceId: string, role: string) => void;
  isPending?: boolean;
};

export function UserWorkspaceAccessDialog({
  open,
  onOpenChange,
  workspaces,
  onSubmit,
  isPending,
}: Props) {
  const { t } = useTranslation();
  const [workspaceId, setWorkspaceId] = useState("");
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  const [role, setRole] = useState("");

  useEffect(() => {
    if (open) {
      setWorkspaceId("");
      setRole("");
    }
  }, [open]);

  const submit = () => {
    if (workspaceId && role) onSubmit(workspaceId, role);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.users.addToWorkspace")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1">
            <span>{t("admin.users.workspace")}</span>
            <select
              className="w-full rounded border p-2"
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setRole("");
              }}
            >
              <option value="">{t("admin.users.selectWorkspace")}</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span>{t("admin.users.role")}</span>
            <select
              className="w-full rounded border p-2"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={!selectedWorkspace}
            >
              <option value="">{t("admin.users.selectRole")}</option>
              {selectedWorkspace?.roles.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={!workspaceId || !role || isPending}
          >
            {t("admin.users.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
