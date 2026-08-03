import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import updateUserStatus from "@/fetchers/instance/update-user-status";
import { toast } from "@/lib/toast";

export default function useUpdateUserStatus() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: updateUserStatus,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["instance", "users"] });
      toast.success(t("admin:users.toast.statusUpdated"));
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin:users.toast.statusUpdateFailed"),
      ),
  });
}
