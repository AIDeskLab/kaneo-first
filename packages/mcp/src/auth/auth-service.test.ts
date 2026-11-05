import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { AuthService } from "./auth-service.js";

const {
  loadCredentialsMock,
  clearCredentialsMock,
  saveCredentialsMock,
  requestDeviceCodeMock,
  pollDeviceAccessTokenMock,
  openMock,
} = vi.hoisted(() => ({
  loadCredentialsMock: vi.fn(),
  clearCredentialsMock: vi.fn(),
  saveCredentialsMock: vi.fn(),
  requestDeviceCodeMock: vi.fn(),
  pollDeviceAccessTokenMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("./token-store.js", () => ({
  loadCredentials: loadCredentialsMock,
  clearCredentials: clearCredentialsMock,
  saveCredentials: saveCredentialsMock,
}));

vi.mock("./device-flow.js", () => ({
  requestDeviceCode: requestDeviceCodeMock,
  pollDeviceAccessToken: pollDeviceAccessTokenMock,
}));

vi.mock("open", () => ({
  default: openMock,
}));

const originalStdinIsTTY = Object.getOwnPropertyDescriptor(
  process.stdin,
  "isTTY",
);

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
}

function restoreStdinIsTTY(): void {
  if (originalStdinIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    return;
  }
  delete (process.stdin as { isTTY?: boolean }).isTTY;
}

describe("AuthService", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    loadCredentialsMock.mockReset();
    clearCredentialsMock.mockReset();
    saveCredentialsMock.mockReset();
    requestDeviceCodeMock.mockReset();
    pollDeviceAccessTokenMock.mockReset();
    openMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreStdinIsTTY();
    vi.restoreAllMocks();
  });

  it("returns the API key without starting the device flow", async () => {
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      apiKey: "kaneo_test_key",
    });

    await expect(service.getAccessToken()).resolves.toBe("kaneo_test_key");
    expect(loadCredentialsMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("reuses the cached token when validation succeeds", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached-token",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("cached-token");
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(clearCredentialsMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("keeps the cached token when validation cannot confirm validity", async () => {
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached-token",
    });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("temporary network failure"),
      ) as typeof fetch;

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("cached-token");
    expect(clearCredentialsMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("clears the cached token and starts device auth after a 401", async () => {
    setStdinIsTTY(true);
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "expired-token",
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    ) as typeof fetch;
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://verify.example.com",
      interval: 5,
    });
    pollDeviceAccessTokenMock.mockResolvedValue("fresh-token");

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("fresh-token");
    expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
    expect(requestDeviceCodeMock).toHaveBeenCalledWith(
      "https://api.example.com",
      "kaneo-mcp",
    );
    expect(saveCredentialsMock).toHaveBeenCalledWith({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "fresh-token",
    });
  });

  it("does not replace a rejected cached token with the device flow when stdin is not a TTY", async () => {
    setStdinIsTTY(false);
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "expired-token",
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    ) as typeof fetch;

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).rejects.toThrow(
      "A token or KANEO_API_KEY is required.",
    );
    expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("does not start the device flow without a TTY or cached token", async () => {
    setStdinIsTTY(false);
    loadCredentialsMock.mockResolvedValue(null);

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).rejects.toThrow(
      "A token or KANEO_API_KEY is required.",
    );
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("starts the device flow on a TTY when no token is cached", async () => {
    setStdinIsTTY(true);
    loadCredentialsMock.mockResolvedValue(null);
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://verify.example.com",
      interval: 5,
    });
    pollDeviceAccessTokenMock.mockResolvedValue("tty-token");

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("tty-token");
    expect(requestDeviceCodeMock).toHaveBeenCalledWith(
      "https://api.example.com",
      "kaneo-mcp",
    );
  });
});
