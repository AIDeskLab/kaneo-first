import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const consumeFixedWindowRateLimits = vi.fn(async () => ({
    allowed: true,
    retryAfterSeconds: 60,
  }));
  const insertedSessions: Array<Record<string, unknown>> = [];
  const getSession = vi.fn(async ({ headers }: { headers: Headers }) => {
    const cookie = new Headers(headers).get("cookie") ?? "";
    if (cookie.includes("victim_session=1")) {
      return {
        user: { id: "victim-user" },
        session: { token: "victim-cookie-token" },
      };
    }
    return null;
  });
  const insert = vi.fn(() => ({
    values: vi.fn(async (row: Record<string, unknown>) => {
      insertedSessions.push(row);
      return row;
    }),
  }));
  return {
    consumeFixedWindowRateLimits,
    getSession,
    insert,
    insertedSessions,
  };
});

vi.mock("../../apps/api/src/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("../../apps/api/src/database", () => ({
  default: { insert: mocks.insert },
}));

vi.mock("../../apps/api/src/mcp/tools", () => ({
  registerMcpTools: vi.fn(),
}));

vi.mock("../../apps/api/src/mcp/oauth-store", () => {
  const rows = new Map<string, { payload: unknown; expiresAt: Date }>();
  const keyOf = (kind: string, key: string) => `${kind}:${key}`;
  return {
    consumeFixedWindowRateLimits: mocks.consumeFixedWindowRateLimits,
    StateCapacityError: class StateCapacityError extends Error {},
    putState: async (
      kind: string,
      key: string,
      payload: unknown,
      expiresAt: Date,
    ) => {
      rows.set(keyOf(kind, key), { payload, expiresAt });
    },
    putStateWithCap: async (
      kind: string,
      key: string,
      payload: unknown,
      expiresAt: Date,
      maxRows: number,
    ) => {
      const now = Date.now();
      for (const [storedKey, row] of rows) {
        if (row.expiresAt.getTime() < now) rows.delete(storedKey);
      }
      const kindPrefix = `${kind}:`;
      const kindRowCount = [...rows.keys()].filter((storedKey) =>
        storedKey.startsWith(kindPrefix),
      ).length;
      if (kindRowCount >= maxRows) {
        throw new Error("OAuth state capacity reached");
      }
      rows.set(keyOf(kind, key), { payload, expiresAt });
    },
    putAuthorizationRequestWithCaps: async (
      key: string,
      payload: unknown,
      expiresAt: Date,
    ) => {
      rows.set(keyOf("request", key), { payload, expiresAt });
    },
    getState: async (kind: string, key: string) => {
      const row = rows.get(keyOf(kind, key));
      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) return null;
      return row.payload;
    },
    consumeState: async (kind: string, key: string) => {
      const row = rows.get(keyOf(kind, key));
      rows.delete(keyOf(kind, key));
      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) return null;
      return row.payload;
    },
    enforceStateCap: async () => {},
    deleteExpiredStates: async () => {
      const now = Date.now();
      for (const [key, row] of rows) {
        if (row.expiresAt.getTime() < now) rows.delete(key);
      }
    },
  };
});

import mcpRoutes from "../../apps/api/src/mcp";
import {
  consumeAuthorizationRateLimits,
  consumeClientRegistrationRateLimits,
  createAuthorizationRequest,
  getAuthorizationRequest,
} from "../../apps/api/src/mcp/oauth";

beforeEach(() => {
  mocks.consumeFixedWindowRateLimits.mockClear();
  mocks.consumeFixedWindowRateLimits.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 60,
  });
});

const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
const clientOrigin = new URL(clientUrl).origin;

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function registerClient(redirectUri: string) {
  const response = await mcpRoutes.request("/mcp/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP client",
      redirect_uris: [redirectUri],
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { client_id: string };
}

function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  verifier: string,
  state: string | undefined = "client-state",
) {
  const url = new URL("http://api.local/mcp/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (state !== undefined) url.searchParams.set("state", state);
  return url;
}

async function decideAuthorization(params: {
  clientId: string;
  redirectUri: string;
  verifier: string;
  approved: boolean;
  state?: string;
}) {
  const authorizeUrl = buildAuthorizeUrl(
    params.clientId,
    params.redirectUri,
    params.verifier,
    params.state,
  );
  const authorize = await mcpRoutes.request(authorizeUrl.toString(), {
    redirect: "manual",
  });
  expect(authorize.status).toBe(302);
  const consentUrl = new URL(authorize.headers.get("location") ?? "");
  const requestId = consentUrl.searchParams.get("request_id");
  expect(requestId).toBeTruthy();

  const decision = await mcpRoutes.request(
    `/mcp/authorize/request/${requestId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "victim_session=1",
        origin: clientOrigin,
      },
      body: JSON.stringify({ approved: params.approved }),
    },
  );
  expect(decision.status).toBe(200);
  const body = (await decision.json()) as { redirect: string };
  return new URL(body.redirect);
}

describe("MCP OAuth security", () => {
  it("partitions registration by connection source with a global emergency limit", async () => {
    await consumeClientRegistrationRateLimits("203.0.113.10");
    expect(mocks.consumeFixedWindowRateLimits).toHaveBeenCalledWith([
      {
        key: "client-registration:source:203.0.113.10",
        maxRequests: 20,
        windowMs: 60_000,
      },
      {
        key: "client-registration:global",
        maxRequests: 600,
        windowMs: 60_000,
      },
    ]);
  });

  it("rate limits authorization by source, registered client, and global ceiling", async () => {
    await consumeAuthorizationRateLimits("203.0.113.11", "client-a");
    expect(mocks.consumeFixedWindowRateLimits).toHaveBeenCalledWith([
      {
        key: "authorization:source:203.0.113.11",
        maxRequests: 120,
        windowMs: 60_000,
      },
      {
        key: "authorization:client:client-a",
        maxRequests: 300,
        windowMs: 60_000,
      },
      {
        key: "authorization:global",
        maxRequests: 3_000,
        windowMs: 60_000,
      },
    ]);
  });

  it("does not trust X-Forwarded-For as the registration source", async () => {
    const response = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
      }),
    });
    expect(response.status).toBe(200);
    expect(mocks.consumeFixedWindowRateLimits).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: "client-registration:source:unknown",
        }),
      ]),
    );
    expect(mocks.consumeFixedWindowRateLimits).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("198.51.100.99"),
        }),
      ]),
    );
  });

  it("rate limits public client registration", async () => {
    mocks.consumeFixedWindowRateLimits.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 42,
    });

    const response = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Rate limited client",
        redirect_uris: ["https://client.example/callback"],
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    await expect(response.json()).resolves.toEqual({
      error: "too_many_requests",
    });
  });

  it("bounds public client registration metadata and request size", async () => {
    const tooManyRedirects = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: Array.from(
          { length: 11 },
          (_, index) => `https://client.example/callback/${index}`,
        ),
      }),
    });
    expect(tooManyRedirects.status).toBe(400);

    const oversized = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "x".repeat(33 * 1024),
        redirect_uris: ["https://client.example/callback"],
      }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "request_too_large",
    });
  });

  it("rejects empty and unsafe redirect URI registrations", async () => {
    const empty = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    expect(empty.status).toBe(400);

    const remoteHttp = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://attacker.example/callback"],
      }),
    });
    expect(remoteHttp.status).toBe(400);
  });

  it("requires an exact registered redirect URI", async () => {
    const registeredRedirect = "https://client.example/callback";
    const client = await registerClient(registeredRedirect);
    const authorizeUrl = buildAuthorizeUrl(
      client.client_id,
      "https://attacker.example/collect",
      "verifier-for-redirect-check",
    );

    const response = await mcpRoutes.request(authorizeUrl.toString(), {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_redirect_uri",
    });
  });

  it("requires explicit same-origin approval before issuing a code", async () => {
    const redirectUri = "https://client.example/callback";
    const verifier = "attacker-known-verifier-1234567890";
    const client = await registerClient(redirectUri);
    const authorizeUrl = buildAuthorizeUrl(
      client.client_id,
      redirectUri,
      verifier,
    );

    const authorize = await mcpRoutes.request(authorizeUrl.toString(), {
      headers: { cookie: "victim_session=1" },
      redirect: "manual",
    });
    expect(authorize.status).toBe(302);
    const consentUrl = new URL(authorize.headers.get("location") ?? "");
    expect(consentUrl.origin).toBe(clientOrigin);
    expect(consentUrl.pathname).toBe("/mcp/authorize");
    expect(consentUrl.searchParams.has("code")).toBe(false);
    expect(mocks.getSession).not.toHaveBeenCalled();

    const requestId = consentUrl.searchParams.get("request_id");
    expect(requestId).toBeTruthy();

    const crossOriginDecision = await mcpRoutes.request(
      `/mcp/authorize/request/${requestId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "victim_session=1",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(crossOriginDecision.status).toBe(403);

    const unauthenticatedDecision = await mcpRoutes.request(
      `/mcp/authorize/request/${requestId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: clientOrigin,
        },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(unauthenticatedDecision.status).toBe(401);

    const approval = await mcpRoutes.request(
      `/mcp/authorize/request/${requestId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "victim_session=1",
          origin: clientOrigin,
        },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(approval.status).toBe(200);
    const approvalBody = (await approval.json()) as { redirect: string };
    const callback = new URL(approvalBody.redirect);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("client-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    expect(mocks.insertedSessions.at(-1)?.userId).toBe("victim-user");

    const replay = await mcpRoutes.request(
      `/mcp/authorize/request/${requestId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "victim_session=1",
          origin: clientOrigin,
        },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(replay.status).toBe(404);
  });

  it("preserves an explicitly empty state value", async () => {
    const redirectUri = "https://client.example/empty-state";
    const client = await registerClient(redirectUri);
    const callback = await decideAuthorization({
      clientId: client.client_id,
      redirectUri,
      verifier: "empty-state-verifier",
      approved: false,
      state: "",
    });

    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.has("state")).toBe(true);
    expect(callback.searchParams.get("state")).toBe("");
  });

  it("consumes an authorization code after a failed redemption attempt", async () => {
    const redirectUri = "https://client.example/single-use";
    const verifier = "single-use-verifier";
    const client = await registerClient(redirectUri);
    const callback = await decideAuthorization({
      clientId: client.client_id,
      redirectUri,
      verifier,
      approved: true,
    });
    const code = callback.searchParams.get("code") ?? "";

    const redeem = (codeVerifier: string) =>
      mcpRoutes.request("/mcp/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

    expect((await redeem("incorrect-verifier")).status).toBe(400);
    expect((await redeem(verifier)).status).toBe(400);
  });

  it.each(["application/x-www-form-urlencoded", "application/json"])(
    "rejects oversized %s token bodies before parsing",
    async (contentType) => {
      const response = await mcpRoutes.request("/mcp/token", {
        method: "POST",
        headers: { "content-type": contentType },
        body: "{".repeat(8 * 1024 + 1),
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "request_too_large",
      });
    },
  );

  it("accepts normally sized JSON token requests", async () => {
    const response = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "not-supported" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported_grant_type",
    });
  });

  it("sweeps expired authorization requests when creating a new one", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const expiredRequestId = await createAuthorizationRequest({
        clientId: "client-expired",
        redirectUri: "https://client.example/expired",
        codeChallenge: "challenge",
      });

      vi.setSystemTime(now + 10 * 60 * 1000 + 1);
      await createAuthorizationRequest({
        clientId: "client-current",
        redirectUri: "https://client.example/current",
        codeChallenge: "challenge",
      });

      await expect(
        getAuthorizationRequest(expiredRequestId),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
