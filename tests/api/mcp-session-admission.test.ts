import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../apps/api/src/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({ user: { id: "test-user" } })),
    },
  },
}));

import mcpRoutes, { shutdownMcpSessions } from "../../apps/api/src/mcp";

const handlerFiles = ["index.ts", "modern.ts", "legacy-server.ts"] as const;

function readMcpSource(name: string): string {
  return readFileSync(
    new URL(`../../apps/api/src/mcp/${name}`, import.meta.url),
    "utf8",
  );
}

describe("stateless /api/mcp", () => {
  it("never consults a process-local session map", async () => {
    expect(
      existsSync(
        new URL("../../apps/api/src/mcp/session-admission.ts", import.meta.url),
      ),
    ).toBe(false);

    const sources = handlerFiles.map(readMcpSource).join("\n");
    expect(sources).not.toMatch(/session-admission/);
    expect(sources).not.toMatch(
      /createMcpSessionAdmission|mcpSessionAdmission|tryReserveSession|closeAllSessions/,
    );
    expect(sources).not.toMatch(/new Map/);
    expect(sources).toMatch(/sessionIdGenerator:\s*undefined/);

    const shutdown = sources.match(
      /export async function shutdownMcpSessions\(\) \{([\s\S]*?)\n\}/,
    );
    expect(shutdown?.[1] ?? "").not.toMatch(
      /\b(Map|sessions|closeAll|tryReserve)\b/,
    );
    await expect(shutdownMcpSessions()).resolves.toBeUndefined();

    const response = await mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "mcp-session-id": "missing-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});
