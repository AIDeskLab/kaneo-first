import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import removeUserFromWorkspace from "@/fetchers/instance/remove-user-from-workspace";
import { toast } from "@/lib/toast";

export default function useRemoveUserFromWorkspace() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: removeUserFromWorkspace,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["instance", "users"] });
      toast.success(t("admin:users.toast.removed"));
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin:users.toast.removeFailed"),
      ),
  });
}
