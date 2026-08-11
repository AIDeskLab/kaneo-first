import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../task/controllers/workspace-assignee-lock";

const WORKSPACE_LABEL_LOCK_NAMESPACE = 1533;

export function normalizeLabelIdentity(name: string) {
  return name.trim().toLocaleLowerCase("en-US");
}

export async function lockWorkspaceLabels(
  tx: DbOrTx,
  workspaceId: string,
  labelNames: string[],
) {
  const keys = [
    ...new Set(
      labelNames
        .map(normalizeLabelIdentity)
        .filter(Boolean)
        .map((name) => `${workspaceId}:${name}`),
    ),
  ].sort();

  for (const key of keys) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${WORKSPACE_LABEL_LOCK_NAMESPACE}, hashtext(${key}))`,
    );
  }
}
