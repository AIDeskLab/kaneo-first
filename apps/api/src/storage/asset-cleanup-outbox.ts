import { asc, eq, lte } from "drizzle-orm";
import db from "../database";
import { assetCleanupOutboxTable } from "../database/schema";
import { deleteS3Object } from "./s3";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_ERROR_LENGTH = 500;
const MINUTE_MS = 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * MINUTE_MS, MAX_BACKOFF_MS);
}

function boundErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export async function enqueueAssetCleanupKeys(
  tx: DatabaseTransaction,
  keys: string[],
): Promise<void> {
  const uniqueKeys = [
    ...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0)),
  ];
  if (uniqueKeys.length === 0) {
    return;
  }

  await tx
    .insert(assetCleanupOutboxTable)
    .values(uniqueKeys.map((objectKey) => ({ objectKey })))
    .onConflictDoNothing({
      target: assetCleanupOutboxTable.objectKey,
    });
}

export async function processAssetCleanupOutbox({
  limit = 100,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(assetCleanupOutboxTable)
      .where(lte(assetCleanupOutboxTable.nextAttemptAt, now))
      .orderBy(
        asc(assetCleanupOutboxTable.createdAt),
        asc(assetCleanupOutboxTable.id),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await deleteS3Object(row.objectKey);
        await tx
          .delete(assetCleanupOutboxTable)
          .where(eq(assetCleanupOutboxTable.id, row.id));
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error("Failed to process asset cleanup outbox row", {
          id: row.id,
          objectKey: row.objectKey,
          error,
        });
        try {
          const attempts = row.attempts + 1;
          await tx
            .update(assetCleanupOutboxTable)
            .set({
              attempts,
              lastError: boundErrorText(error),
              nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
            })
            .where(eq(assetCleanupOutboxTable.id, row.id));
        } catch (updateError) {
          console.error("Failed to update asset cleanup outbox row", {
            id: row.id,
            objectKey: row.objectKey,
            error: updateError,
          });
        }
      }
    }

    return {
      processed: rows.length,
      succeeded,
      failed,
    };
  });
}
