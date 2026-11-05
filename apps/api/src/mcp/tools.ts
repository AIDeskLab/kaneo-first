import { registerTools, type ToolRegistrar } from "@kaneo/mcp/tools";
import { fetchUpstream, parseUpstreamJson } from "@kaneo/mcp/upstream";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export type McpToolRegistrar = ToolRegistrar;

type ShapeToolServer = {
  registerTool(
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    callback: (args: unknown) => Promise<CallToolResult>,
  ): unknown;
};

export function toMcpToolRegistrar(server: ShapeToolServer): McpToolRegistrar {
  return {
    registerTool: (name, config, callback) =>
      server.registerTool(
        name,
        {
          description: config.description,
          inputSchema: config.inputSchema.shape,
        },
        (args) => callback(args),
      ),
  };
}

class ApiClient {
  readonly usingApiKey = false;
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetchUpstream(url, path, init, headers);
    return parseUpstreamJson<T>(res, path);
  }
}

export function registerMcpTools(
  server: McpToolRegistrar,
  baseUrl: string,
  token: string,
): void {
  registerTools(server, { client: new ApiClient(baseUrl, token) });
}
