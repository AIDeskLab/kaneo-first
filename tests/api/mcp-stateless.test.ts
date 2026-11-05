import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLegacyRequest } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import mcpRoutes from "../../apps/api/src/mcp";
import { createModernMcpHandler } from "../../apps/api/src/mcp/modern";
import { registerTools } from "../../packages/mcp/src/tools/register";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ user: { id: "test-user" } })),
}));

vi.mock("../../apps/api/src/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } },
}));

const protocolVersion = "2026-07-28";

const currentUser = {
  id: "test-user",
  name: "Test User",
  email: "test@example.com",
  role: "user",
};

const sessionResponse = {
  user: { ...currentUser, token: "unexpected-user-secret" },
  session: {
    id: "test-session",
    token: "live-session-secret",
    expiresAt: "2026-11-08T00:00:00.000Z",
  },
};

function modernRequest(
  method: string,
  id: number,
  params: Record<string, unknown> = {},
): Request {
  const name = method === "tools/call" ? String(params.name) : undefined;
  return new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": protocolVersion,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": {
            name: "kaneo-stateless-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

type RpcBody = {
  result: {
    tools: unknown[];
    content: Array<{ text: string }>;
  };
  error?: unknown;
};

async function rpcBody(response: Response): Promise<RpcBody> {
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  return JSON.parse(data ?? text) as RpcBody;
}

function toolNamesFrom(tools: Array<{ name?: string }>): string[] {
  return tools.map((tool) => tool.name ?? "").sort();
}

async function httpToolNames(): Promise<string[]> {
  const handler = createModernMcpHandler("test-token", "http://api.test");
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await handler.fetch(
      modernRequest("tools/list", page + 1, cursor ? { cursor } : {}),
    );
    expect(response.status).toBe(200);
    const body = await rpcBody(response);
    const tools = body.result.tools as Array<{ name: string }>;
    names.push(...toolNamesFrom(tools));
    const next = (body.result as { nextCursor?: string }).nextCursor;
    if (!next) break;
    cursor = next;
  }
  return names.sort();
}

async function stdioToolNames(): Promise<string[]> {
  const server = new McpServer({ name: "kaneo-mcp", version: "0.0.0-test" });
  registerTools(server, {
    client: {
      json: async () => {
        throw new Error("tools/list must not call Kaneo");
      },
    },
  });
  const client = new Client({ name: "tool-list-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined);
      names.push(...toolNamesFrom(listed.tools));
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
    return names.sort();
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  authMocks.getSession.mockClear();
});

describe("MCP 2026-07-28 stateless HTTP", () => {
  it("serves tools/list on independent HTTP requests without session IDs", async () => {
    const handler = createModernMcpHandler("test-token", "http://api.test");

    const first = await handler.fetch(modernRequest("tools/list", 1));
    const second = await handler.fetch(modernRequest("tools/list", 2));
    const firstBody = await rpcBody(first);
    const secondBody = await rpcBody(second);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.has("mcp-session-id")).toBe(false);
    expect(second.headers.has("mcp-session-id")).toBe(false);
    expect(firstBody.result.tools).toEqual(secondBody.result.tools);
    expect(firstBody.result.tools).toContainEqual(
      expect.objectContaining({ name: "whoami" }),
    );
    expect(firstBody.result.tools).toContainEqual(
      expect.objectContaining({ name: "get_my_tasks" }),
    );
  });

  it("lists the same tool names over HTTP and stdio, including get_my_tasks", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("tools/list must not call Kaneo");
    });
    vi.stubGlobal("fetch", fetchMock);

    const httpNames = await httpToolNames();
    const stdioNames = await stdioToolNames();

    expect(stdioNames).toEqual(httpNames);
    expect(new Set(httpNames).size).toBe(httpNames.length);
    expect(httpNames).toContain("get_my_tasks");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles concurrent read-only calls with per-request authentication", async () => {
    const apiFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-token",
        );
        return Response.json(sessionResponse);
      },
    );
    vi.stubGlobal("fetch", apiFetch);
    const handler = createModernMcpHandler("test-token", "http://api.test");

    const responses = await Promise.all(
      [1, 2, 3, 4].map((id) =>
        handler.fetch(
          modernRequest("tools/call", id, {
            name: "whoami",
            arguments: {},
          }),
        ),
      ),
    );
    const bodies = await Promise.all(responses.map(rpcBody));

    expect(apiFetch).toHaveBeenCalledTimes(4);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    for (const body of bodies) {
      expect(JSON.parse(body.result.content[0].text)).toEqual(currentUser);
      expect(JSON.stringify(body)).not.toContain("live-session-secret");
      expect(JSON.stringify(body)).not.toContain("unexpected-user-secret");
    }
  });

  it("gets one task by ticket ID through the HTTP MCP server", async () => {
    const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "http://api.test/api/task/by-ticket-id/KAN-12?workspaceId=workspace+1&projectId=project+1",
      );
      return Response.json({ id: "task-1", title: "Direct match" });
    });
    vi.stubGlobal("fetch", apiFetch);
    const handler = createModernMcpHandler("test-token", "http://api.test");

    const response = await handler.fetch(
      modernRequest("tools/call", 1, {
        name: "get_task_by_ticket_id",
        arguments: {
          ticketId: "KAN-12",
          workspaceId: "workspace 1",
          projectId: "project 1",
        },
      }),
    );
    const body = await rpcBody(response);

    expect(response.status).toBe(200);
    expect(body.result.content[0].text).toContain("Direct match");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("validates bearer authentication on every modern POST", async () => {
    const responses = await Promise.all(
      [1, 2].map((id) =>
        mcpRoutes.request(modernRequest("tools/list", id), undefined),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(authMocks.getSession).toHaveBeenCalledTimes(2);
    for (const call of authMocks.getSession.mock.calls) {
      expect(new Headers(call[0].headers).get("authorization")).toBe(
        "Bearer test-token",
      );
    }
  });

  it("rejects a modern request without the required per-request metadata", async () => {
    const handler = createModernMcpHandler("test-token", "http://api.test");
    const request = new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const response = await handler.fetch(request);
    const body = await rpcBody(response);

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("executes an effectful tool on a separate request", async () => {
    const apiFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("http://api.test/api/task/status/task-1");
        expect(init?.method).toBe("PUT");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-token",
        );
        expect(JSON.parse(String(init?.body))).toEqual({ status: "qa" });
        return Response.json({ id: "task-1", status: "qa" });
      },
    );
    vi.stubGlobal("fetch", apiFetch);
    const handler = createModernMcpHandler("test-token", "http://api.test");

    const response = await handler.fetch(
      modernRequest("tools/call", 1, {
        name: "update_task_status",
        arguments: { taskId: "task-1", status: "qa" },
      }),
    );
    const body = await rpcBody(response);

    expect(response.status).toBe(200);
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(body.result.content[0].text).toContain('"status": "qa"');
  });

  it("keeps legacy initialize traffic on the sessionful route", async () => {
    const legacy = new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1.0.0" },
        },
      }),
    });

    expect(await isLegacyRequest(legacy)).toBe(true);
    expect(await isLegacyRequest(modernRequest("tools/list", 2))).toBe(false);
  });

  it("rejects non-POST requests before cloning for protocol classification", async () => {
    const request = new Request("http://mcp.test/mcp", {
      method: "GET",
      headers: { authorization: "Bearer test-token" },
    });
    const clone = vi.spyOn(request, "clone");

    const response = await mcpRoutes.request(request);

    expect(response.status).toBe(405);
    expect(clone).not.toHaveBeenCalled();
  });

  it("handles a legacy request carrying an old session ID", async () => {
    const request = new Request("http://mcp.test/mcp", {
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
    const response = await mcpRoutes.request(request);

    expect(response.status).toBe(200);
    expect((await rpcBody(response)).result.tools).toContainEqual(
      expect.objectContaining({ name: "whoami" }),
    );

    const unauthenticated = new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": "missing-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect((await mcpRoutes.request(unauthenticated)).status).toBe(401);
  });

  it("advertises the canonical protected-resource metadata URL on 401", async () => {
    const response = await mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate") ?? "";
    expect(header.startsWith("Bearer ")).toBe(true);
    expect(header).toContain("/.well-known/oauth-protected-resource/api/mcp");
    // RFC 9728 inserts the well-known path before the resource path, so the
    // advertised URL must not carry the API mount before it.
    expect(header).not.toContain("/api/.well-known/oauth-protected-resource");
  });

  it("serves legacy requests across replicas without a session ID", async () => {
    const replicaA = await import("../../apps/api/src/mcp");
    vi.resetModules();
    const replicaB = await import("../../apps/api/src/mcp");
    const initialize = await replicaA.default.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.has("mcp-session-id")).toBe(false);

    const initialized = await replicaB.default.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    const tools = await replicaB.default.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    const toolsBody = await rpcBody(tools);
    const apiFetch = vi.fn(async () => Response.json(sessionResponse));
    vi.stubGlobal("fetch", apiFetch);
    const call = await replicaB.default.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      }),
    });
    const callBody = await rpcBody(call);

    expect(initialized.status).toBe(202);
    expect(tools.status).toBe(200);
    expect(call.status).toBe(200);
    expect(tools.headers.has("mcp-session-id")).toBe(false);
    expect(toolsBody.result.tools).toContainEqual(
      expect.objectContaining({ name: "whoami" }),
    );
    expect(JSON.parse(callBody.result.content[0].text)).toEqual(currentUser);
    expect(JSON.stringify(callBody)).not.toContain("live-session-secret");
    expect(JSON.stringify(callBody)).not.toContain("unexpected-user-secret");
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(authMocks.getSession).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["text/plain", "text/plain"],
    ["a form post", "application/x-www-form-urlencoded"],
    ["a missing header", undefined],
  ])(
    "rejects %s with 415 before either era is dispatched",
    async (_label, contentType) => {
      const response = await mcpRoutes.request("/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-token",
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      expect(response.status).toBe(415);
    },
  );

  it("accepts a parameterised json media type", async () => {
    const response = await mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "kaneo-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
  });

  it("returns a tool error rather than throwing when arguments fail validation", async () => {
    const handler = createModernMcpHandler("test-token", "http://api.test");

    const response = await handler.fetch(
      modernRequest("tools/call", 1, {
        name: "get_task",
        arguments: { taskId: "" },
      }),
    );
    const body = (await rpcBody(response)) as unknown as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("taskId");
  });
});
