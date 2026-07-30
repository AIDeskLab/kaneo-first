import { registerSW } from "virtual:pwa-register";
import i18n from "i18next";
import { toast } from "@/lib/toast";

export function initServiceWorker() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast(i18n.t("pwa:updateAvailable"), {
        action: {
          label: i18n.t("pwa:refresh"),
          onClick: () => {
            updateSW(true);
          },
        },
      });
    },
    onOfflineReady() {
      toast.success(i18n.t("pwa:offlineReady"));
    },
  });
}
