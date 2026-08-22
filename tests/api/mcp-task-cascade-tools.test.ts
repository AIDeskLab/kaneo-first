import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpTools } from "../../apps/api/src/mcp/tools";
import { registerTools } from "../../packages/mcp/src/tools/register";

type RegisteredTool = {
  name: string;
  config: {
    description?: string;
    inputSchema?: { parse: (args: unknown) => unknown };
  };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

function createServerMock() {
  const tools = new Map<string, RegisteredTool>();

  return {
    server: {
      registerTool: vi.fn(
        (
          name: string,
          config: RegisteredTool["config"],
          handler: RegisteredTool["handler"],
        ) => {
          tools.set(name, { name, config, handler });
        },
      ),
    },
    tools,
  };
}

function mockFetchOk(body: unknown = {}) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  }));
}

describe("MCP task cascade tools (HTTP)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers delete_task as DELETE /api/task/:id with taskId input", async () => {
    const { server, tools } = createServerMock();
    const fetchMock = mockFetchOk({ id: "task-1" });
    vi.stubGlobal("fetch", fetchMock);

    registerMcpTools(server as never, "http://api.local", "token");

    const tool = tools.get("delete_task");
    expect(tool).toBeDefined();
    expect(tool?.config.description).toMatch(/cascade/i);

    const schema = tool?.config.inputSchema;
    expect(schema).toBeDefined();
    expect(schema?.parse({ taskId: "task-1" })).toEqual({ taskId: "task-1" });
    expect(() => schema?.parse({})).toThrow();
    expect(() => schema?.parse({ taskId: "  " })).toThrow();

    await tool?.handler({ taskId: "task 1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.local/api/task/task%201",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps update_task_status on PUT /api/task/status/:id with cascade docs", async () => {
    const { server, tools } = createServerMock();
    const fetchMock = mockFetchOk({ id: "task-1", status: "done" });
    vi.stubGlobal("fetch", fetchMock);

    registerMcpTools(server as never, "http://api.local", "token");

    const tool = tools.get("update_task_status");
    expect(tool).toBeDefined();
    expect(tool?.config.description).toMatch(
      /cascades to recursive subtask descendants/i,
    );

    expect(
      tool?.config.inputSchema?.parse({
        taskId: "task-1",
        status: "done",
      }),
    ).toEqual({ taskId: "task-1", status: "done" });

    await tool?.handler({ taskId: "task-1", status: "done" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.local/api/task/status/task-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ status: "done" }),
      }),
    );
  });

  it("keeps HTTP and stdio delete_task equivalent", async () => {
    const http = createServerMock();
    const stdio = createServerMock();
    const fetchMock = mockFetchOk({ id: "task-1" });
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      json: vi.fn().mockResolvedValue({ id: "task-1" }),
    };

    registerMcpTools(http.server as never, "http://api.local", "token");
    registerTools(stdio.server as never, { client: client as never });

    const httpDelete = http.tools.get("delete_task");
    const stdioDelete = stdio.tools.get("delete_task");

    expect(httpDelete).toBeDefined();
    expect(stdioDelete).toBeDefined();
    expect(httpDelete?.config.description).toBe(
      stdioDelete?.config.description,
    );

    await httpDelete?.handler({ taskId: "task-1" });
    await stdioDelete?.handler({ taskId: "task-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.local/api/task/task-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(client.json).toHaveBeenCalledWith("/api/task/task-1", {
      method: "DELETE",
    });
  });
});
