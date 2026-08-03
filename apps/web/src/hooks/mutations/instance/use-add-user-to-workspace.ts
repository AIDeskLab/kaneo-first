import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import addUserToWorkspace from "@/fetchers/instance/add-user-to-workspace";
import { toast } from "@/lib/toast";

export default function useAddUserToWorkspace() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: addUserToWorkspace,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["instance", "users"] });
      toast.success(t("admin:users.toast.added"));
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin:users.toast.addFailed"),
      ),
  });
}
