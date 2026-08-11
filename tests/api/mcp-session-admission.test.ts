import { beforeEach, describe, expect, it, vi } from "vitest";

const endpointMocks = vi.hoisted(() => {
  process.env.KANEO_MCP_MAX_GLOBAL_SESSIONS = "2";
  process.env.KANEO_MCP_MAX_PER_USER_SESSIONS = "2";
  process.env.KANEO_MCP_SESSION_IDLE_TIMEOUT_MS = "60000";
  process.env.KANEO_MCP_SESSION_RESERVATION_TIMEOUT_MS = "60000";

  const getSession = vi.fn(async ({ headers }: { headers: Headers }) => {
    const auth = new Headers(headers).get("authorization") ?? "";
    if (auth.includes("token-user-a")) {
      return {
        user: { id: "user-a" },
        session: { token: "token-user-a" },
      };
    }
    return null;
  });

  return { getSession };
});

vi.mock("../../apps/api/src/auth", () => ({
  auth: { api: { getSession: endpointMocks.getSession } },
}));

vi.mock("../../apps/api/src/utils/verify-api-key", () => ({
  verifyApiKey: vi.fn(async () => null),
}));

vi.mock("../../apps/api/src/mcp/tools", () => ({
  registerMcpTools: vi.fn(),
}));

import {
  createMcpSessionAdmission,
  mcpSessionAdmission,
} from "../../apps/api/src/mcp/session-admission";

type FakeTransport = {
  close: ReturnType<typeof vi.fn>;
  sessionId?: string;
};

function createTransport(sessionId: string): FakeTransport {
  return {
    sessionId,
    close: vi.fn(async () => {}),
  };
}

describe("MCP session admission", () => {
  let now: number;
  let admission: ReturnType<typeof createMcpSessionAdmission>;

  beforeEach(() => {
    now = 1_000_000;
    admission = createMcpSessionAdmission({
      maxGlobalSessions: 2,
      maxPerUserSessions: 1,
      idleTimeoutMs: 1_000,
      reservationTimeoutMs: 500,
      now: () => now,
    });
  });

  it("reserves up to global and per-user caps before commit and rejects extra reserves", () => {
    const first = admission.tryReserveSession("user-a");
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    expect(admission.tryReserveSession("user-a")).toEqual({
      allowed: false,
      reason: "user_capacity",
    });

    const secondUser = admission.tryReserveSession("user-b");
    expect(secondUser.allowed).toBe(true);
    if (!secondUser.allowed) return;

    expect(admission.tryReserveSession("user-c")).toEqual({
      allowed: false,
      reason: "global_capacity",
    });

    expect(admission.sessions.size).toBe(0);
    expect(admission.reservations.size).toBe(2);
  });

  it("releases reservation capacity without creating a session", () => {
    const reserved = admission.tryReserveSession("user-a");
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    expect(admission.tryReserveSession("user-a")).toEqual({
      allowed: false,
      reason: "user_capacity",
    });

    admission.releaseReservation(reserved.reservationId);
    expect(admission.reservations.size).toBe(0);

    expect(admission.tryReserveSession("user-a")).toEqual({
      allowed: true,
      reservationId: expect.any(String),
    });
  });

  it("commits a valid reservation into an active session", () => {
    const reserved = admission.tryReserveSession("user-a");
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    const transport = createTransport("s1");
    const committed = admission.commitReservation(
      reserved.reservationId,
      "s1",
      transport as never,
      "user-a",
    );
    expect(committed).toEqual({ ok: true });
    expect(admission.reservations.size).toBe(0);
    expect(admission.sessions.has("s1")).toBe(true);
  });

  it("reclaims stale reservations so commit fails and capacity is freed", () => {
    const reserved = admission.tryReserveSession("user-a");
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    now += admission.reservationTimeoutMs + 1;
    admission.reclaimStaleReservations();
    expect(admission.reservations.size).toBe(0);

    const transport = createTransport("s1");
    const committed = admission.commitReservation(
      reserved.reservationId,
      "s1",
      transport as never,
      "user-a",
    );
    expect(committed).toEqual({ ok: false, reason: "reservation_invalid" });

    const retry = admission.tryReserveSession("user-a");
    expect(retry.allowed).toBe(true);
  });

  it("does not remove an existing session when duplicate commit cleanup runs onclose", () => {
    const first = admission.tryReserveSession("user-a");
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    const firstTransport = createTransport("s1");
    expect(
      admission.commitReservation(
        first.reservationId,
        "s1",
        firstTransport as never,
        "user-a",
      ),
    ).toEqual({ ok: true });

    const second = admission.tryReserveSession("user-b");
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;

    const secondTransport = createTransport("s1");
    expect(
      admission.commitReservation(
        second.reservationId,
        "s1",
        secondTransport as never,
        "user-b",
      ),
    ).toEqual({ ok: false, reason: "duplicate_session" });

    admission.removeSession("s1", secondTransport as never);
    admission.removeSession("s1", secondTransport as never);

    expect(admission.sessions.get("s1")?.transport).toBe(firstTransport);
    expect(admission.sessions.get("s1")?.userId).toBe("user-a");
    expect(firstTransport.close).not.toHaveBeenCalled();
    expect(secondTransport.close).not.toHaveBeenCalled();
    expect(admission.sessions.size).toBe(1);
    expect(admission.reservations.size).toBe(0);

    const retry = admission.tryReserveSession("user-c");
    expect(retry.allowed).toBe(true);
    if (!retry.allowed) return;
    admission.releaseReservation(retry.reservationId);
  });

  it("rejects duplicate session IDs without overwriting existing sessions", () => {
    const first = admission.tryReserveSession("user-a");
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    const firstTransport = createTransport("s1");
    expect(
      admission.commitReservation(
        first.reservationId,
        "s1",
        firstTransport as never,
        "user-a",
      ),
    ).toEqual({ ok: true });

    const second = admission.tryReserveSession("user-b");
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;

    const secondTransport = createTransport("s1");
    expect(
      admission.commitReservation(
        second.reservationId,
        "s1",
        secondTransport as never,
        "user-b",
      ),
    ).toEqual({ ok: false, reason: "duplicate_session" });

    expect(admission.sessions.get("s1")?.userId).toBe("user-a");
    expect(secondTransport.close).not.toHaveBeenCalled();
  });

  it("isolates session ownership across users", () => {
    const reserved = admission.tryReserveSession("user-a");
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    admission.commitReservation(
      reserved.reservationId,
      "s1",
      createTransport("s1") as never,
      "user-a",
    );
    expect(admission.getSession("s1", "user-b")).toBeNull();
  });

  it("reclaims only idle sessions and refreshes activity on valid reuse", async () => {
    const reserved = admission.tryReserveSession("user-a");
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    const transport = createTransport("s1");
    admission.commitReservation(
      reserved.reservationId,
      "s1",
      transport as never,
      "user-a",
    );
    admission.touchSession("s1");
    now += 2_000;
    admission.reclaimIdleSessions();

    expect(admission.sessions.has("s1")).toBe(false);
    expect(transport.close).toHaveBeenCalledOnce();

    const freshReserve = admission.tryReserveSession("user-a");
    expect(freshReserve.allowed).toBe(true);
    if (!freshReserve.allowed) return;

    const fresh = createTransport("s2");
    admission.commitReservation(
      freshReserve.reservationId,
      "s2",
      fresh as never,
      "user-a",
    );
    admission.getSession("s2", "user-a");
    now += 500;
    admission.reclaimIdleSessions();
    expect(admission.sessions.has("s2")).toBe(true);
  });

  it("does not evict active sessions when capacity is full", () => {
    const first = admission.tryReserveSession("user-a");
    const second = admission.tryReserveSession("user-b");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) return;

    admission.commitReservation(
      first.reservationId,
      "s1",
      createTransport("s1") as never,
      "user-a",
    );
    admission.commitReservation(
      second.reservationId,
      "s2",
      createTransport("s2") as never,
      "user-b",
    );

    expect(admission.tryReserveSession("user-c")).toEqual({
      allowed: false,
      reason: "global_capacity",
    });
    expect(admission.sessions.size).toBe(2);
  });

  it("removes sessions on close and shutdown clears active sessions and pending reservations", async () => {
    const reserved = admission.tryReserveSession("user-a");
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    const transport = createTransport("s1");
    admission.commitReservation(
      reserved.reservationId,
      "s1",
      transport as never,
      "user-a",
    );
    admission.removeSession("s1", transport as never);
    expect(admission.sessions.has("s1")).toBe(false);

    const pending = admission.tryReserveSession("user-a");
    expect(pending.allowed).toBe(true);
    if (!pending.allowed) return;
    expect(admission.reservations.size).toBe(1);

    admission.commitReservation(
      pending.reservationId,
      "s2",
      transport as never,
      "user-a",
    );
    await admission.closeAllSessions();
    expect(admission.sessions.size).toBe(0);
    expect(admission.reservations.size).toBe(0);
    expect(transport.close).toHaveBeenCalled();
  });

  it("interleaves reserves to exact caps while commits are still pending", () => {
    const globalAdmission = createMcpSessionAdmission({
      maxGlobalSessions: 3,
      maxPerUserSessions: 2,
      idleTimeoutMs: 1_000,
      reservationTimeoutMs: 500,
      now: () => now,
    });

    const first = globalAdmission.tryReserveSession("user-a");
    const second = globalAdmission.tryReserveSession("user-a");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) return;

    expect(globalAdmission.tryReserveSession("user-a")).toEqual({
      allowed: false,
      reason: "user_capacity",
    });

    const third = globalAdmission.tryReserveSession("user-b");
    expect(third.allowed).toBe(true);
    if (!third.allowed) return;

    expect(globalAdmission.tryReserveSession("user-c")).toEqual({
      allowed: false,
      reason: "global_capacity",
    });

    globalAdmission.releaseReservation(second.reservationId);
    const replacement = globalAdmission.tryReserveSession("user-a");
    expect(replacement.allowed).toBe(true);
    if (!replacement.allowed) return;

    globalAdmission.commitReservation(
      first.reservationId,
      "s1",
      createTransport("s1") as never,
      "user-a",
    );
    globalAdmission.commitReservation(
      third.reservationId,
      "s2",
      createTransport("s2") as never,
      "user-b",
    );
    globalAdmission.commitReservation(
      replacement.reservationId,
      "s3",
      createTransport("s3") as never,
      "user-a",
    );

    expect(globalAdmission.sessions.size).toBe(3);
    expect(globalAdmission.reservations.size).toBe(0);
    expect(globalAdmission.tryReserveSession("user-d")).toEqual({
      allowed: false,
      reason: "global_capacity",
    });
  });
});

describe("MCP session admission endpoint concurrency", () => {
  beforeEach(() => {
    endpointMocks.getSession.mockClear();
  });

  it("returns 503 from the MCP endpoint when capacity is already exhausted", async () => {
    await mcpSessionAdmission.closeAllSessions();
    for (let index = 0; index < 2; index++) {
      const reserved = mcpSessionAdmission.tryReserveSession("user-a");
      expect(reserved.allowed).toBe(true);
      if (!reserved.allowed) return;
      mcpSessionAdmission.commitReservation(
        reserved.reservationId,
        `occupied-${index}`,
        createTransport(`occupied-${index}`) as never,
        "user-a",
      );
    }

    const { default: mcpRoutes } = await import("../../apps/api/src/mcp");
    const response = await mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer token-user-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "server_busy",
      error_description: "MCP session capacity reached",
    });
  });

  it("models concurrent initialize admission after async auth without exceeding caps", async () => {
    const admission = createMcpSessionAdmission({
      maxGlobalSessions: 2,
      maxPerUserSessions: 2,
      idleTimeoutMs: 60_000,
      reservationTimeoutMs: 60_000,
    });

    let nextSessionId = 0;
    const simulateInitialize = async (userId: string) => {
      await Promise.resolve();
      const reservation = admission.tryReserveSession(userId);
      if (!reservation.allowed) {
        return 503;
      }

      await Promise.resolve();
      const sessionId = `session-${nextSessionId++}`;
      const committed = admission.commitReservation(
        reservation.reservationId,
        sessionId,
        createTransport(sessionId) as never,
        userId,
      );
      if (!committed.ok) {
        admission.releaseReservation(reservation.reservationId);
        return 503;
      }

      return 200;
    };

    const statuses = await Promise.all(
      Array.from({ length: 4 }, () => simulateInitialize("user-a")),
    );

    expect(statuses.filter((status) => status === 200).length).toBe(2);
    expect(statuses.filter((status) => status === 503).length).toBe(2);
    expect(admission.sessions.size).toBe(2);
    expect(admission.reservations.size).toBe(0);
  });
});
