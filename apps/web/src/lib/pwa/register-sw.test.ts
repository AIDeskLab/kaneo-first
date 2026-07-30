import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegisterSW = vi.fn();
const mockToast = vi.fn();
const mockToastSuccess = vi.fn();
const mockI18nT = vi.fn((key: string) => key);

vi.mock("virtual:pwa-register", () => ({
  registerSW: (...args: unknown[]) => mockRegisterSW(...args),
}));

vi.mock("i18next", () => ({
  default: {
    t: (key: string) => mockI18nT(key),
  },
}));

vi.mock("@/lib/toast", () => ({
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
    mockI18nT.mockReset();
    mockI18nT.mockImplementation((key: string) => key);
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

    expect(mockI18nT).toHaveBeenCalledWith("pwa:updateAvailable");
    expect(mockI18nT).toHaveBeenCalledWith("pwa:refresh");
    expect(mockToast).toHaveBeenCalledWith(
      "pwa:updateAvailable",
      expect.objectContaining({
        action: expect.objectContaining({
          label: "pwa:refresh",
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

    expect(mockI18nT).toHaveBeenCalledWith("pwa:offlineReady");
    expect(mockToastSuccess).toHaveBeenCalledWith("pwa:offlineReady");
  });
});
