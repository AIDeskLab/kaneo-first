import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import updateUserWorkspaceRole from "@/fetchers/instance/update-user-workspace-role";
import { toast } from "@/lib/toast";

export default function useUpdateUserWorkspaceRole() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: updateUserWorkspaceRole,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["instance", "users"] });
      toast.success(t("admin:users.toast.roleUpdated"));
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin:users.toast.roleUpdateFailed"),
      ),
  });
}
