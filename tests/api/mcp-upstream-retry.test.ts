import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { registerMcpTools } from "../../apps/api/src/mcp/tools";

type ToolResult = {
  content: Array<{ text: string }>;
  isError?: boolean;
};

function collectTools() {
  const tools = new Map<string, (args: unknown) => Promise<ToolResult>>();
  registerMcpTools(
    {
      registerTool: (name, _config, callback) => tools.set(name, callback),
    },
    "http://api.test",
    "test-token",
  );
  return tools;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function useUpstreamTimers() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, ms);
    return controller.signal;
  });
}

function hangUntilAbort(_url: string, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }
    const fail = () =>
      reject(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP upstream retries", () => {
  it("calls Kaneo again after a 429 and returns the next success", async () => {
    useUpstreamTimers();
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "Slow down" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "p1", name: "Inbox" }));
    vi.stubGlobal("fetch", apiFetch);
    const tools = collectTools();

    const pending = tools.get("get_project")?.({ id: "p1" });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(String(apiFetch.mock.calls[0]?.[0])).toBe(
      "http://api.test/api/project/p1",
    );
    expect(String(apiFetch.mock.calls[1]?.[0])).toBe(
      "http://api.test/api/project/p1",
    );
    expect(result?.isError).toBe(false);
    expect(result?.content[0]?.text).toContain("Inbox");
  });

  it("honors Retry-After before the second call", async () => {
    useUpstreamTimers();
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { message: "Slow down" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: "p1" }));
    vi.stubGlobal("fetch", apiFetch);
    const tools = collectTools();

    const pending = tools.get("get_project")?.({ id: "p1" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(result?.isError).toBe(false);
  });

  it("reports a hung request as an isError timeout that names the path", async () => {
    useUpstreamTimers();
    const apiFetch = vi.fn(hangUntilAbort);
    vi.stubGlobal("fetch", apiFetch);
    const tools = collectTools();

    const pending = tools.get("get_project")?.({ id: "slow" });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(String(apiFetch.mock.calls[0]?.[0])).toBe(
      "http://api.test/api/project/slow",
    );
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("/api/project/slow");
    expect(result?.content[0]?.text).toContain("timeout");
  });

  it("does not retry an ambiguous POST failure", async () => {
    useUpstreamTimers();
    const apiFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { message: "Bad gateway" }));
    vi.stubGlobal("fetch", apiFetch);
    const tools = collectTools();

    const pending = tools.get("create_project")?.({
      name: "Inbox",
      workspaceId: "ws",
      icon: "folder",
      slug: "inbox",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Bad gateway");
  });

  it("keeps issues and code when an error body has no message", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        code: "VALIDATION_ERROR",
        issues: [{ path: "body.title", message: "Required" }],
      }),
    );
    vi.stubGlobal("fetch", apiFetch);
    const tools = collectTools();

    const result = await tools.get("get_project")?.({ id: "p1" });

    expect(result?.isError).toBe(true);
    const text = result?.content[0]?.text ?? "";
    expect(text).toContain("body.title");
    expect(text).toContain("Required");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).not.toMatch(/HTTP 400/);
  });
});
