import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegisterSW = vi.fn();
const mockToast = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("virtual:pwa-register", () => ({
  registerSW: (...args: unknown[]) => mockRegisterSW(...args),
}));

vi.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => mockToast(...args), {
    success: (...args: unknown[]) => mockToastSuccess(...args),
  }),
}));

import { initServiceWorker } from "./register-sw";

describe("initServiceWorker", () => {
  beforeEach(() => {
    mockRegisterSW.mockReset();
    mockToast.mockReset();
    mockToastSuccess.mockReset();
  });
  it("registers the service worker with immediate: true", () => {
    mockRegisterSW.mockReturnValue(vi.fn());

    initServiceWorker();

    expect(mockRegisterSW).toHaveBeenCalledWith(
      expect.objectContaining({
        immediate: true,
        onNeedRefresh: expect.any(Function),
        onOfflineReady: expect.any(Function),
      }),
    );
  });

  it("shows a refresh toast when onNeedRefresh is called", () => {
    const mockUpdateSW = vi.fn();
    mockRegisterSW.mockImplementation(
      (options: { onNeedRefresh?: () => void }) => {
        options.onNeedRefresh?.();
        return mockUpdateSW;
      },
    );

    initServiceWorker();

    expect(mockToast).toHaveBeenCalledWith(
      "Доступна новая версия",
      expect.objectContaining({
        action: expect.objectContaining({
          label: "Обновить",
          onClick: expect.any(Function),
        }),
      }),
    );

    const toastOptions = mockToast.mock.calls[0]?.[1] as {
      action?: { onClick?: () => void };
    };
    toastOptions.action?.onClick?.();
    expect(mockUpdateSW).toHaveBeenCalledWith(true);
  });

  it("shows a success toast when onOfflineReady is called", () => {
    mockRegisterSW.mockImplementation(
      (options: { onOfflineReady?: () => void }) => {
        options.onOfflineReady?.();
        return vi.fn();
      },
    );

    initServiceWorker();

    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Приложение готово к работе офлайн",
    );
  });
});
