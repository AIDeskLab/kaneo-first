import { getDatabasePool } from "../../../apps/api/src/database";

export const WORKSPACE_LABEL_LOCK_NAMESPACE = 1533;

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function waitForBlockedLabelMutations(minWaiters: number) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await getDatabasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = $1
         AND NOT granted`,
      [WORKSPACE_LABEL_LOCK_NAMESPACE],
    );

    if (Number(result.rows[0]?.count) >= minWaiters) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(
    `Label mutations did not reach ${minWaiters} blocked waiters on the advisory lock`,
  );
}
