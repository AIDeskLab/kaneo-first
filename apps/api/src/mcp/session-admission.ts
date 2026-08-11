import { randomUUID } from "node:crypto";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export type McpSessionRecord = {
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
  lastActivityAt: number;
};

export type McpReservationRecord = {
  userId: string;
  createdAt: number;
};

export type McpSessionAdmissionOptions = {
  maxGlobalSessions: number;
  maxPerUserSessions: number;
  idleTimeoutMs: number;
  reservationTimeoutMs: number;
  now?: () => number;
};

const DEFAULT_MAX_GLOBAL_SESSIONS = 200;
const DEFAULT_MAX_PER_USER_SESSIONS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RESERVATION_TIMEOUT_MS = 60 * 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createMcpSessionAdmission(
  options: Partial<McpSessionAdmissionOptions> = {},
) {
  const maxGlobalSessions =
    options.maxGlobalSessions ??
    parsePositiveInt(
      process.env.KANEO_MCP_MAX_GLOBAL_SESSIONS,
      DEFAULT_MAX_GLOBAL_SESSIONS,
    );
  const maxPerUserSessions =
    options.maxPerUserSessions ??
    parsePositiveInt(
      process.env.KANEO_MCP_MAX_PER_USER_SESSIONS,
      DEFAULT_MAX_PER_USER_SESSIONS,
    );
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    parsePositiveInt(
      process.env.KANEO_MCP_SESSION_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
    );
  const reservationTimeoutMs =
    options.reservationTimeoutMs ??
    parsePositiveInt(
      process.env.KANEO_MCP_SESSION_RESERVATION_TIMEOUT_MS,
      DEFAULT_RESERVATION_TIMEOUT_MS,
    );
  const now = options.now ?? (() => Date.now());

  const sessions = new Map<string, McpSessionRecord>();
  const reservations = new Map<string, McpReservationRecord>();

  function reclaimIdleSessions() {
    const cutoff = now() - idleTimeoutMs;
    for (const [sessionId, record] of sessions) {
      if (record.lastActivityAt >= cutoff) continue;
      sessions.delete(sessionId);
      void record.transport.close().catch(() => {});
    }
  }

  function reclaimStaleReservations() {
    const cutoff = now() - reservationTimeoutMs;
    for (const [reservationId, record] of reservations) {
      if (record.createdAt >= cutoff) continue;
      reservations.delete(reservationId);
    }
  }

  function countSessionsForUser(userId: string) {
    let count = 0;
    for (const record of sessions.values()) {
      if (record.userId === userId) count += 1;
    }
    return count;
  }

  function countReservationsForUser(userId: string) {
    let count = 0;
    for (const record of reservations.values()) {
      if (record.userId === userId) count += 1;
    }
    return count;
  }

  function occupiedGlobalCount() {
    return sessions.size + reservations.size;
  }

  function occupiedForUserCount(userId: string) {
    return countSessionsForUser(userId) + countReservationsForUser(userId);
  }

  function touchSession(sessionId: string) {
    const record = sessions.get(sessionId);
    if (!record) return null;
    record.lastActivityAt = now();
    return record;
  }

  function getSession(sessionId: string, userId: string) {
    reclaimIdleSessions();
    reclaimStaleReservations();
    const record = sessions.get(sessionId);
    if (!record || record.userId !== userId) {
      return null;
    }
    record.lastActivityAt = now();
    return record;
  }

  function tryReserveSession(userId: string) {
    reclaimIdleSessions();
    reclaimStaleReservations();

    if (occupiedGlobalCount() >= maxGlobalSessions) {
      return { allowed: false as const, reason: "global_capacity" as const };
    }
    if (occupiedForUserCount(userId) >= maxPerUserSessions) {
      return { allowed: false as const, reason: "user_capacity" as const };
    }

    const reservationId = randomUUID();
    reservations.set(reservationId, {
      userId,
      createdAt: now(),
    });
    return { allowed: true as const, reservationId };
  }

  function releaseReservation(reservationId: string) {
    reservations.delete(reservationId);
  }

  function commitReservation(
    reservationId: string,
    sessionId: string,
    transport: WebStandardStreamableHTTPServerTransport,
    userId: string,
  ) {
    reclaimStaleReservations();

    const reservation = reservations.get(reservationId);
    if (!reservation || reservation.userId !== userId) {
      return {
        ok: false as const,
        reason: "reservation_invalid" as const,
      };
    }

    if (sessions.has(sessionId)) {
      reservations.delete(reservationId);
      return {
        ok: false as const,
        reason: "duplicate_session" as const,
      };
    }

    reservations.delete(reservationId);
    sessions.set(sessionId, {
      transport,
      userId,
      lastActivityAt: now(),
    });
    return { ok: true as const };
  }

  function removeSession(
    sessionId: string,
    expectedTransport: WebStandardStreamableHTTPServerTransport,
  ) {
    const record = sessions.get(sessionId);
    if (!record || record.transport !== expectedTransport) {
      return;
    }
    sessions.delete(sessionId);
  }

  async function closeAllSessions() {
    const closers = [...sessions.values()].map((record) =>
      record.transport.close().catch(() => {}),
    );
    sessions.clear();
    reservations.clear();
    await Promise.all(closers);
  }

  return {
    closeAllSessions,
    commitReservation,
    getSession,
    maxGlobalSessions,
    maxPerUserSessions,
    reclaimIdleSessions,
    reclaimStaleReservations,
    releaseReservation,
    removeSession,
    reservations,
    reservationTimeoutMs,
    sessions,
    touchSession,
    tryReserveSession,
  };
}

export type McpSessionAdmission = ReturnType<typeof createMcpSessionAdmission>;

export const mcpSessionAdmission = createMcpSessionAdmission();
