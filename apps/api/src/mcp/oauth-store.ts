import { and, count, eq, inArray, lte, sql } from "drizzle-orm";
import db from "../database";
import { mcpOauthStateTable } from "../database/schema";

export type OauthStateKind = "client" | "code" | "rate" | "request";

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type FixedWindowRateLimit = {
  key: string;
  maxRequests: number;
  windowMs: number;
};

export class StateCapacityError extends Error {
  constructor() {
    super("OAuth state capacity reached");
    this.name = "StateCapacityError";
  }
}

export async function putState(
  kind: OauthStateKind,
  key: string,
  payload: unknown,
  expiresAt: Date,
): Promise<void> {
  await db.insert(mcpOauthStateTable).values({ kind, key, payload, expiresAt });
}

export async function putStateWithCap(
  kind: OauthStateKind,
  key: string,
  payload: unknown,
  expiresAt: Date,
  maxRows: number,
): Promise<void> {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error("State cap must be a positive integer");
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1527, hashtext(${kind}))`,
    );
    await tx
      .delete(mcpOauthStateTable)
      .where(
        and(
          eq(mcpOauthStateTable.kind, kind),
          lte(mcpOauthStateTable.expiresAt, new Date()),
        ),
      );

    const [countRow] = await tx
      .select({ pending: count() })
      .from(mcpOauthStateTable)
      .where(eq(mcpOauthStateTable.kind, kind));
    if ((countRow?.pending ?? 0) >= maxRows) throw new StateCapacityError();

    await tx
      .insert(mcpOauthStateTable)
      .values({ kind, key, payload, expiresAt });
  });
}

export async function putAuthorizationRequestWithCaps(
  key: string,
  payload: { clientId: string } & Record<string, unknown>,
  expiresAt: Date,
  globalCap: number,
  clientCap: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    // One global lock makes the cleanup, both counts, and insert atomic across replicas.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1528, 1)`);
    await tx
      .delete(mcpOauthStateTable)
      .where(
        and(
          eq(mcpOauthStateTable.kind, "request"),
          lte(mcpOauthStateTable.expiresAt, new Date()),
        ),
      );
    const [counts] = await tx
      .select({
        total: count(),
        forClient: sql<number>`count(*) filter (where ${mcpOauthStateTable.payload}->>'clientId' = ${payload.clientId})`,
      })
      .from(mcpOauthStateTable)
      .where(eq(mcpOauthStateTable.kind, "request"));
    if (
      (counts?.total ?? 0) >= globalCap ||
      Number(counts?.forClient ?? 0) >= clientCap
    ) {
      throw new StateCapacityError();
    }
    await tx
      .insert(mcpOauthStateTable)
      .values({ kind: "request", key, payload, expiresAt });
  });
}

export async function getState<T>(
  kind: OauthStateKind,
  key: string,
): Promise<T | null> {
  const [row] = await db
    .select()
    .from(mcpOauthStateTable)
    .where(
      and(eq(mcpOauthStateTable.kind, kind), eq(mcpOauthStateTable.key, key)),
    )
    .limit(1);

  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row.payload as T;
}

// Single DELETE ... RETURNING keeps consumption single-use across replicas.
export async function consumeState<T>(
  kind: OauthStateKind,
  key: string,
): Promise<T | null> {
  const [row] = await db
    .delete(mcpOauthStateTable)
    .where(
      and(eq(mcpOauthStateTable.kind, kind), eq(mcpOauthStateTable.key, key)),
    )
    .returning();

  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row.payload as T;
}

export async function deleteExpiredStates(): Promise<void> {
  await db
    .delete(mcpOauthStateTable)
    .where(lte(mcpOauthStateTable.expiresAt, new Date()));
}

export async function consumeFixedWindowRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<RateLimitResult> {
  return consumeFixedWindowRateLimits([{ key, maxRequests, windowMs }]);
}

export async function consumeFixedWindowRateLimits(
  limits: FixedWindowRateLimit[],
): Promise<RateLimitResult> {
  if (limits.length === 0) {
    throw new Error("At least one rate limit is required");
  }
  for (const limit of limits) {
    if (
      !limit.key ||
      !Number.isSafeInteger(limit.maxRequests) ||
      limit.maxRequests < 1 ||
      !Number.isSafeInteger(limit.windowMs) ||
      limit.windowMs < 1
    ) {
      throw new Error("Rate limits require a key and positive integer bounds");
    }
  }
  const keys = [...new Set(limits.map(({ key }) => key))].sort();
  if (keys.length !== limits.length) {
    throw new Error("Rate limit keys must be unique");
  }

  return db.transaction(async (tx) => {
    for (const key of keys) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(1526, hashtext(${key}))`,
      );
    }

    const now = new Date();
    await tx
      .delete(mcpOauthStateTable)
      .where(
        and(
          eq(mcpOauthStateTable.kind, "rate"),
          lte(mcpOauthStateTable.expiresAt, now),
        ),
      );

    const rows = await tx
      .select()
      .from(mcpOauthStateTable)
      .where(
        and(
          eq(mcpOauthStateTable.kind, "rate"),
          inArray(mcpOauthStateTable.key, keys),
        ),
      );
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const states = limits.map((limit) => {
      const row = rowsByKey.get(limit.key);
      const countValue = (row?.payload as { count?: unknown } | undefined)
        ?.count;
      const currentCount =
        row &&
        typeof countValue === "number" &&
        Number.isSafeInteger(countValue)
          ? countValue
          : row
            ? limit.maxRequests
            : 0;
      const retryAfterSeconds = row
        ? Math.max(
            1,
            Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000),
          )
        : Math.ceil(limit.windowMs / 1000);
      return { limit, row, currentCount, retryAfterSeconds };
    });
    const denied = states.filter(
      ({ limit, currentCount }) => currentCount >= limit.maxRequests,
    );
    if (denied.length > 0) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          ...denied.map(({ retryAfterSeconds }) => retryAfterSeconds),
        ),
      };
    }

    for (const { limit, row, currentCount } of states) {
      if (row) {
        await tx
          .update(mcpOauthStateTable)
          .set({ payload: { count: currentCount + 1 }, updatedAt: now })
          .where(
            and(
              eq(mcpOauthStateTable.kind, "rate"),
              eq(mcpOauthStateTable.key, limit.key),
            ),
          );
      } else {
        await tx.insert(mcpOauthStateTable).values({
          kind: "rate",
          key: limit.key,
          payload: { count: 1 },
          expiresAt: new Date(now.getTime() + limit.windowMs),
        });
      }
    }
    return {
      allowed: true,
      retryAfterSeconds: Math.max(
        ...states.map(({ retryAfterSeconds }) => retryAfterSeconds),
      ),
    };
  });
}
