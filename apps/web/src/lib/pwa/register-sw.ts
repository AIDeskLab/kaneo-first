import { registerSW } from "virtual:pwa-register";
import { toast } from "sonner";

export function initServiceWorker() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast("Доступна новая версия", {
        action: {
          label: "Обновить",
          onClick: () => {
            updateSW(true);
          },
        },
      });
    },
    onOfflineReady() {
      toast.success("Приложение готово к работе офлайн");
    },
  });
}
