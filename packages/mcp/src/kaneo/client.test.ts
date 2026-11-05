import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { registerTools } from "../tools/register.js";
import { KaneoClient } from "./client.js";
import { UPSTREAM_MAX_RETRY_DELAY_MS } from "./upstream.js";

describe("KaneoClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("adds auth and json headers for requests with a body", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(
      client.json("/api/project", {
        method: "POST",
        body: JSON.stringify({ name: "Inbox" }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("clears the cached token and retries once after a 401", async () => {
    const auth = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "Unauthorized", code: "UNAUTHORIZED" }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "task-1" }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(client.json("/api/task/task-1")).resolves.toEqual({
      id: "task-1",
    });
    expect(auth.clearToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces api error messages when a request fails", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Task not found", code: "NOT_FOUND" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      ),
    ) as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(client.json("/api/task/missing")).rejects.toThrow(
      "/api/task/missing: Task not found (NOT_FOUND)",
    );
  });

  it("names missing permissions through the error code", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Insufficient API key scope",
          code: "API_KEY_SCOPE",
          missingPermissions: ["task:update"],
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(client.json("/api/task/task-1")).rejects.toThrow(
      "/api/task/task-1: Insufficient API key scope (API_KEY_SCOPE)",
    );
  });

  it("falls back to a text body from an older API", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("Task not found", { status: 404 }),
      ) as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(client.json("/api/task/missing")).rejects.toThrow(
      /^\/api\/task\/missing: Task not found$/,
    );
  });

  it("retries a 429 and then reads the successful response", async () => {
    useUpstreamTimers();
    const fetchMock = installFetch(
      jsonResponse(429, { message: "Slow down" }),
      jsonResponse(200, { id: "task-1" }),
    );
    const { client } = createClient();

    const pending = client.json("/api/task/task-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    await expect(pending).resolves.toEqual({ id: "task-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/task/task-1",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.example.com/api/task/task-1",
    );
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
  });

  it("waits for a Retry-After delay in seconds", async () => {
    useUpstreamTimers();
    const fetchMock = installFetch(
      jsonResponse(429, { message: "Slow down" }, { "retry-after": "2" }),
      jsonResponse(200, { ok: true }),
    );
    const { client } = createClient();

    const pending = client.json("/api/task/task-1");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits for a Retry-After HTTP date", async () => {
    useUpstreamTimers();
    vi.setSystemTime(new Date("2026-11-05T16:00:00.000Z"));
    const fetchMock = installFetch(
      jsonResponse(
        503,
        { message: "Busy" },
        {
          "retry-after": "Thu, 05 Nov 2026 16:00:02 GMT",
        },
      ),
      jsonResponse(200, { ok: true }),
    );
    const { client } = createClient();

    const pending = client.json("/api/task/task-1");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps a long Retry-After", async () => {
    useUpstreamTimers();
    const fetchMock = installFetch(
      jsonResponse(429, { message: "Slow down" }, { "retry-after": "120" }),
      jsonResponse(200, { ok: true }),
    );
    const { client } = createClient();

    const pending = client.json("/api/task/task-1");
    await vi.advanceTimersByTimeAsync(UPSTREAM_MAX_RETRY_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 504])(
    "retries an idempotent %s and stops after two retries",
    async (status) => {
      useUpstreamTimers();
      const fetchMock = installFetch(
        jsonResponse(status, {}),
        jsonResponse(status, {}),
        jsonResponse(status, {}),
        jsonResponse(200, { ok: true }),
      );
      const { client } = createClient();

      const pending = client.json("/api/task/task-1");
      const settled = pending.then(
        () => "ok" as const,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(BACKOFF_MS + BACKOFF_MS * 2);
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`/api/task/task-1: HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("does not retry a POST when the gateway response is ambiguous", async () => {
    useUpstreamTimers();
    const fetchMock = installFetch(
      jsonResponse(502, { message: "Bad gateway" }),
      jsonResponse(200, { ok: true }),
    );
    const { client } = createClient();

    const pending = client.json("/api/project", { method: "POST" });
    const settled = pending.then(
      () => "ok" as const,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(UPSTREAM_MAX_RETRY_DELAY_MS);
    await expect(settled).resolves.toEqual(
      expect.objectContaining({ message: "/api/project: Bad gateway" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a POST 429 only when Retry-After is present", async () => {
    useUpstreamTimers();
    const withoutDelay = installFetch(
      jsonResponse(429, { message: "Slow down" }),
    );
    const { client } = createClient();
    const rejected = client.json("/api/project", { method: "POST" }).then(
      () => "ok" as const,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(UPSTREAM_MAX_RETRY_DELAY_MS);
    await expect(rejected).resolves.toEqual(
      expect.objectContaining({ message: "/api/project: Slow down" }),
    );
    expect(withoutDelay).toHaveBeenCalledTimes(1);

    const withDelay = installFetch(
      jsonResponse(429, { message: "Slow down" }, { "retry-after": "1" }),
      jsonResponse(200, { id: "project-1" }),
    );
    const pending = client.json("/api/project", { method: "POST" });
    await vi.advanceTimersByTimeAsync(999);
    expect(withDelay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ id: "project-1" });
    expect(withDelay).toHaveBeenCalledTimes(2);
  });

  it("retries a POST 503 only when Retry-After is present", async () => {
    useUpstreamTimers();
    const fetchMock = installFetch(
      jsonResponse(503, {}, { "retry-after": "0" }),
      jsonResponse(200, { id: "project-1" }),
    );
    const { client } = createClient();

    await expect(
      client.json("/api/project", { method: "POST" }),
    ).resolves.toEqual({ id: "project-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps issues and code when the error body has no message", async () => {
    const { client } = createClient();
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        code: "VALIDATION_ERROR",
        issues: [{ path: "body.title", message: "Required" }],
      }),
    ) as typeof fetch;

    await expect(client.json("/api/task/task-1")).rejects.toThrow(
      "/api/task/task-1: body.title: Required (VALIDATION_ERROR)",
    );
  });

  it("keeps a nested field error instead of the HTTP status", async () => {
    const { client } = createClient();
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: {
          issues: [
            {
              path: [{ key: "title" }],
              message: "Invalid type: Expected string",
            },
          ],
        },
      }),
    ) as typeof fetch;

    await expect(client.json("/api/task/task-1")).rejects.toThrow(
      "/api/task/task-1: title: Invalid type: Expected string",
    );
  });

  it("does not refresh an API key after a 401", async () => {
    const fetchMock = installFetch(
      jsonResponse(401, { message: "Unauthorized" }),
    );
    const { client, auth } = createClient(true);

    await expect(client.json("/api/task/task-1")).rejects.toThrow(
      "/api/task/task-1: Unauthorized",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.clearToken).not.toHaveBeenCalled();
  });

  it("names a hung request as a timeout that includes the path", async () => {
    useUpstreamTimers();
    const fetchMock = vi.fn(hangUntilAbort);
    globalThis.fetch = fetchMock as typeof fetch;
    const { client } = createClient();
    const tools = new Map<
      string,
      (args: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
      }>
    >();
    registerTools(
      {
        registerTool: (_name, _config, handler) => {
          tools.set(_name, handler);
        },
      } as never,
      { client },
    );

    const pending = tools.get("get_project")?.({ id: "slow" });
    const settled = pending?.then((result) => result);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/api/project/slow",
    );
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("/api/project/slow");
    expect(result?.content[0]?.text).toContain("timeout");
  });
});

const BACKOFF_MS = 200;

function createClient(usingApiKey = false) {
  const auth = {
    usingApiKey,
    getAccessToken: vi.fn().mockResolvedValue("token-123"),
    clearToken: vi.fn().mockResolvedValue(undefined),
  };
  return {
    auth,
    client: new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    }),
  };
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

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function installFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
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
