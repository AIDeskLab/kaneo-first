import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import useCreateProjectGroup from "@/hooks/mutations/project-group/use-create-project-group";

type Props = {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
};

export function CreateProjectGroupModal({ open, onClose, workspaceId }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const createMutation = useCreateProjectGroup(workspaceId);
  const [name, setName] = useState("");

  const handleSubmit = () => {
    if (!name.trim()) return;
    createMutation.mutate(name.trim(), {
      onSuccess: () => {
        setName("");
        onClose();
        queryClient.invalidateQueries({
          queryKey: ["project-groups", workspaceId],
        });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("project-groups:create")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder={t("project-groups:name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!name.trim() || createMutation.isPending}
            >
              {t("project-groups:create")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
