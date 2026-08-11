import { eq, sql } from "drizzle-orm";
import type db from "../database";
import { integrationTable } from "../database/schema";
import { githubRepositoryKeyFromConfig } from "./github-repository-key";

export const GITHUB_BINDING_REPAIR_LOCK_NAMESPACE = 1533;

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RepairClient = Pick<DatabaseTransaction, "query" | "update" | "execute">;

export async function repairGitHubRepositoryBindings(
  tx: RepairClient,
  options?: {
    acquireGlobalLock?: boolean;
    desiredActiveByIntegrationId?: Map<string, boolean>;
  },
) {
  if (options?.acquireGlobalLock !== false) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${GITHUB_BINDING_REPAIR_LOCK_NAMESPACE}, 1)`,
    );
  }

  const integrations = await tx.query.integrationTable.findMany({
    where: eq(integrationTable.type, "github"),
  });

  const keyToRows = new Map<string, (typeof integrations)[number][]>();
  const malformedRows: (typeof integrations)[number][] = [];

  for (const row of integrations) {
    let key: string | null = null;
    try {
      key = githubRepositoryKeyFromConfig(JSON.parse(row.config));
    } catch {
      key = null;
    }

    if (!key) {
      malformedRows.push(row);
      continue;
    }

    const group = keyToRows.get(key) ?? [];
    group.push(row);
    keyToRows.set(key, group);
  }

  const now = new Date();

  for (const row of malformedRows) {
    if (row.isActive || row.githubRepositoryKey !== null) {
      await tx
        .update(integrationTable)
        .set({
          isActive: false,
          githubRepositoryKey: null,
          updatedAt: now,
        })
        .where(eq(integrationTable.id, row.id));
    }
  }

  for (const [key, rows] of keyToRows) {
    if (rows.length > 1) {
      for (const row of rows) {
        if (row.isActive || row.githubRepositoryKey !== null) {
          await tx
            .update(integrationTable)
            .set({
              isActive: false,
              githubRepositoryKey: null,
              updatedAt: now,
            })
            .where(eq(integrationTable.id, row.id));
        }
      }
      continue;
    }

    const row = rows[0];
    if (!row) {
      continue;
    }

    const wantsActive =
      options?.desiredActiveByIntegrationId?.get(row.id) ?? row.isActive;

    if (wantsActive) {
      if (row.githubRepositoryKey !== key || !row.isActive) {
        await tx
          .update(integrationTable)
          .set({
            isActive: true,
            githubRepositoryKey: key,
            updatedAt: now,
          })
          .where(eq(integrationTable.id, row.id));
      }
      continue;
    }

    if (row.isActive || row.githubRepositoryKey !== null) {
      await tx
        .update(integrationTable)
        .set({
          isActive: false,
          githubRepositoryKey: null,
          updatedAt: now,
        })
        .where(eq(integrationTable.id, row.id));
    }
  }
}
