import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db from "../../apps/api/src/database";
import { mcpOauthStateTable } from "../../apps/api/src/database/schema";
import {
  consumeFixedWindowRateLimit,
  consumeFixedWindowRateLimits,
  consumeState,
  deleteExpiredStates,
  getState,
  putAuthorizationRequestWithCaps,
  putState,
  putStateWithCap,
  StateCapacityError,
} from "../../apps/api/src/mcp/oauth-store";
import { resetTestDatabase } from "./helpers/database";

describe("mcp oauth store", () => {
  it("atomically enforces a fixed-window rate limit", async () => {
    await resetTestDatabase();
    const key = `rate-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeFixedWindowRateLimit(key, 5, 60_000),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(5);
    expect(results.every((result) => result.retryAfterSeconds > 0)).toBe(true);
  });

  it("does not consume other capacity when any partition denies admission", async () => {
    await resetTestDatabase();
    const partitionKey = `denied-partition-${Date.now()}`;
    const globalKey = `unconsumed-global-${Date.now()}`;
    const limits = [
      { key: partitionKey, maxRequests: 1, windowMs: 60_000 },
      { key: globalKey, maxRequests: 2, windowMs: 60_000 },
    ];

    await expect(consumeFixedWindowRateLimits(limits)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(consumeFixedWindowRateLimits(limits)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(
      consumeFixedWindowRateLimit(globalKey, 2, 60_000),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("does not create rotating partition rows after the global ceiling is exhausted", async () => {
    await resetTestDatabase();
    const globalKey = `rotating-global-${Date.now()}`;
    await consumeFixedWindowRateLimit(globalKey, 1, 60_000);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        consumeFixedWindowRateLimits([
          {
            key: `rotating-source-${index}`,
            maxRequests: 10,
            windowMs: 60_000,
          },
          { key: globalKey, maxRequests: 1, windowMs: 60_000 },
        ]),
      ),
    );
    expect(results.every((result) => !result.allowed)).toBe(true);

    const rows = await db.select().from(mcpOauthStateTable);
    expect(
      rows.filter((row) => row.kind === "rate").map((row) => row.key),
    ).toEqual([globalKey]);
  });

  it("deletes expired rate rows during every admission", async () => {
    await resetTestDatabase();
    await putState(
      "rate",
      "expired-unrelated-rate",
      { count: 99 },
      new Date(Date.now() - 1_000),
    );

    await consumeFixedWindowRateLimit("fresh-rate", 2, 60_000);

    const rows = await db.select().from(mcpOauthStateTable);
    const expired = rows.find(
      (row) => row.kind === "rate" && row.key === "expired-unrelated-rate",
    );
    expect(expired).toBeUndefined();
  });

  it("keeps concurrent multi-key admissions within global and partition limits", async () => {
    await resetTestDatabase();
    const globalKey = `concurrent-global-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        consumeFixedWindowRateLimits([
          {
            key: `concurrent-partition-${index % 2}`,
            maxRequests: 2,
            windowMs: 60_000,
          },
          { key: globalKey, maxRequests: 7, windowMs: 60_000 },
        ]),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(4);

    const rows = (await db.select().from(mcpOauthStateTable)).filter(
      (row) => row.kind === "rate",
    );
    const counts = new Map(
      rows.map((row) => [row.key, (row.payload as { count: number }).count]),
    );
    expect(counts.get(globalKey)).toBe(4);
    expect(counts.get("concurrent-partition-0")).toBe(2);
    expect(counts.get("concurrent-partition-1")).toBe(2);
  });

  it("stores and returns state by kind and key", async () => {
    const key = `client-${Date.now()}`;
    const payload = { clientId: key, redirectUris: ["https://a.example/cb"] };
    await putState("client", key, payload, new Date(Date.now() + 60_000));

    await expect(getState("client", key)).resolves.toEqual(payload);
    await expect(getState("code", key)).resolves.toBeNull();
  });

  it("consumes state exactly once", async () => {
    const key = `code-${Date.now()}`;
    const payload = { clientId: "c", userId: "u" };
    await putState("code", key, payload, new Date(Date.now() + 60_000));

    await expect(consumeState("code", key)).resolves.toEqual(payload);
    await expect(consumeState("code", key)).resolves.toBeNull();
    await expect(getState("code", key)).resolves.toBeNull();
  });

  it("treats expired rows as absent and sweeps them", async () => {
    const key = `request-${Date.now()}`;
    await putState("request", key, { clientId: "c" }, new Date(Date.now() - 1));

    await expect(getState("request", key)).resolves.toBeNull();
    await expect(consumeState("request", `${key}-other`)).resolves.toBeNull();

    await putState(
      "request",
      `${key}-expired`,
      { clientId: "c" },
      new Date(Date.now() - 1),
    );
    await deleteExpiredStates();
    await expect(getState("request", `${key}-expired`)).resolves.toBeNull();
  });

  it("rejects at capacity without evicting existing rows", async () => {
    await resetTestDatabase();
    const base = Date.now();
    const payload = { clientId: "c" };
    await putState("request", "cap-old", payload, new Date(base + 10_000));
    await putState("request", "cap-mid", payload, new Date(base + 20_000));
    await putState("request", "cap-new", payload, new Date(base + 30_000));
    await putState("client", "cap-client", payload, new Date(base + 30_000));

    await expect(
      putStateWithCap(
        "request",
        "cap-next",
        payload,
        new Date(base + 40_000),
        3,
      ),
    ).rejects.toBeInstanceOf(StateCapacityError);
    await expect(getState("request", "cap-old")).resolves.toEqual(payload);
    await expect(getState("request", "cap-mid")).resolves.toEqual(payload);
    await expect(getState("request", "cap-new")).resolves.toEqual(payload);
    await expect(getState("request", "cap-next")).resolves.toBeNull();
    await expect(getState("client", "cap-client")).resolves.toEqual(payload);
  });

  it("atomically accepts only the cap under concurrent inserts", async () => {
    await resetTestDatabase();
    const expiresAt = new Date(Date.now() + 60_000);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        putStateWithCap(
          "client",
          `concurrent-client-${index}`,
          { index },
          expiresAt,
          10,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(10);

    const retained = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        getState("client", `concurrent-client-${index}`),
      ),
    );
    expect(retained.filter(Boolean)).toHaveLength(10);
  });

  it("atomically caps live codes without evicting them", async () => {
    await resetTestDatabase();
    const expiresAt = new Date(Date.now() + 60_000);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        putStateWithCap(
          "code",
          `bounded-code-${index}`,
          { index },
          expiresAt,
          7,
        ),
      ),
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(7);
    const retained = await db
      .select()
      .from(mcpOauthStateTable)
      .where(eq(mcpOauthStateTable.kind, "code"));
    expect(retained).toHaveLength(7);
    expect(retained.every((row) => row.expiresAt.getTime() > Date.now())).toBe(
      true,
    );
  });

  it("reclaims code capacity after expiry and exactly-once consumption", async () => {
    await resetTestDatabase();
    const payload = { clientId: "client", userId: "user" };
    await putStateWithCap(
      "code",
      "expired-code",
      payload,
      new Date(Date.now() - 1),
      1,
    );
    await expect(
      putStateWithCap(
        "code",
        "live-code",
        payload,
        new Date(Date.now() + 60_000),
        1,
      ),
    ).resolves.toBeUndefined();
    await expect(getState("code", "expired-code")).resolves.toBeNull();
    await expect(
      putStateWithCap(
        "code",
        "blocked-code",
        payload,
        new Date(Date.now() + 60_000),
        1,
      ),
    ).rejects.toBeInstanceOf(StateCapacityError);
    await expect(consumeState("code", "live-code")).resolves.toEqual(payload);
    await expect(consumeState("code", "live-code")).resolves.toBeNull();
    await expect(
      putStateWithCap(
        "code",
        "replacement-code",
        payload,
        new Date(Date.now() + 60_000),
        1,
      ),
    ).resolves.toBeUndefined();
  });

  it("enforces per-client request caps without evicting unrelated clients", async () => {
    await resetTestDatabase();
    const expiresAt = new Date(Date.now() + 60_000);
    await putAuthorizationRequestWithCaps(
      "a-1",
      { clientId: "a" },
      expiresAt,
      3,
      1,
    );
    await putAuthorizationRequestWithCaps(
      "b-1",
      { clientId: "b" },
      expiresAt,
      3,
      1,
    );
    await expect(
      putAuthorizationRequestWithCaps(
        "a-2",
        { clientId: "a" },
        expiresAt,
        3,
        1,
      ),
    ).rejects.toBeInstanceOf(StateCapacityError);
    await expect(getState("request", "b-1")).resolves.toEqual({
      clientId: "b",
    });
  });
});
