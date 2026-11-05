import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AuthService } from "./auth/auth-service.js";
import { credentialsPath } from "./auth/token-store.js";
import { KaneoClient } from "./kaneo/client.js";
import { registerTools } from "./tools/register.js";

const { requestDeviceCodeMock } = vi.hoisted(() => ({
  requestDeviceCodeMock: vi.fn(),
}));

vi.mock("./auth/device-flow.js", () => ({
  requestDeviceCode: requestDeviceCodeMock,
  pollDeviceAccessToken: vi.fn(),
}));

vi.mock("open", () => ({
  default: vi.fn(),
}));

type RegisteredTool = {
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

const originalStdinIsTTY = Object.getOwnPropertyDescriptor(
  process.stdin,
  "isTTY",
);
const originalFetch = globalThis.fetch;

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

describe("stdio whoami", () => {
  let configDir: string | undefined;
  const savedEnv = {
    KANEO_API_KEY: process.env.KANEO_API_KEY,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    restoreStdinIsTTY();
    if (savedEnv.KANEO_API_KEY === undefined) delete process.env.KANEO_API_KEY;
    else process.env.KANEO_API_KEY = savedEnv.KANEO_API_KEY;
    if (savedEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
    if (configDir) {
      await rm(configDir, { recursive: true, force: true });
      configDir = undefined;
    }
  });

  it("is an error with no key, a non-TTY stdin, and no credential file", async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "kaneo-mcp-whoami-"));
    delete process.env.KANEO_API_KEY;
    process.env.XDG_CONFIG_HOME = configDir;
    setStdinIsTTY(false);
    requestDeviceCodeMock.mockReset();
    const fetchMock = vi.fn(() => {
      throw new Error("network disabled");
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(access(credentialsPath())).rejects.toMatchObject({
      code: "ENOENT",
    });

    const baseUrl = "http://127.0.0.1:9";
    const auth = new AuthService({
      baseUrl,
      clientId: "kaneo-mcp",
      apiKey: process.env.KANEO_API_KEY || undefined,
    });
    const client = new KaneoClient({ baseUrl, auth });
    const tools = new Map<string, RegisteredTool>();
    registerTools(
      {
        registerTool: (_name, _config, handler) => {
          tools.set(_name, { handler });
        },
      },
      { client },
    );

    const result = await tools.get("whoami")?.handler({});

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(
      "A token or KANEO_API_KEY is required.",
    );
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
