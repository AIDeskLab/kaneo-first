import { and, eq, sql } from "drizzle-orm";
import db from "../../database";
import {
  externalLinkTable,
  integrationTable,
  taskTable,
} from "../../database/schema";
import { repairGitHubRepositoryBindings } from "../../github-integration/github-binding-repair";
import { defaultGitHubConfig } from "./config";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MigrationClient = Pick<
  DatabaseTransaction,
  "query" | "insert" | "update" | "execute"
>;

async function tableExists(
  client: Pick<DatabaseTransaction, "execute">,
  tableName: string,
): Promise<boolean> {
  try {
    const result = await client.execute(sql`
			SELECT EXISTS (
				SELECT FROM information_schema.tables
				WHERE table_schema = 'public'
				AND table_name = ${tableName}
			);
		`);
    return (result.rows[0] as { exists: boolean })?.exists === true;
  } catch {
    return false;
  }
}

export async function migrateGitHubIntegration() {
  const oldTableExists = await tableExists(db, "github_integration");

  if (!oldTableExists) {
    console.log("No old github_integration table found, skipping migration");
    return;
  }

  console.log("🔄 Starting GitHub integration migration...");

  try {
    await db.transaction(async (tx) => {
      const oldIntegrations = await tx.query.githubIntegrationTable.findMany();

      if (oldIntegrations.length === 0) {
        console.log("No old integrations to migrate");
        await dropOldTable(tx);
        return;
      }

      let migratedCount = 0;
      const desiredActiveByIntegrationId = new Map<string, boolean>();

      for (const old of oldIntegrations) {
        const config = JSON.stringify({
          repositoryOwner: old.repositoryOwner,
          repositoryName: old.repositoryName,
          installationId: old.installationId,
          ...defaultGitHubConfig,
        });

        const existingIntegration = await tx.query.integrationTable.findFirst({
          where: and(
            eq(integrationTable.projectId, old.projectId),
            eq(integrationTable.type, "github"),
          ),
        });

        if (existingIntegration) {
          desiredActiveByIntegrationId.set(
            existingIntegration.id,
            old.isActive ?? true,
          );
          await tx
            .update(integrationTable)
            .set({
              config,
              isActive: false,
              githubRepositoryKey: null,
              updatedAt: old.updatedAt ?? new Date(),
            })
            .where(eq(integrationTable.id, existingIntegration.id));
        } else {
          const [created] = await tx
            .insert(integrationTable)
            .values({
              projectId: old.projectId,
              type: "github",
              config,
              isActive: false,
              githubRepositoryKey: null,
              createdAt: old.createdAt,
              updatedAt: old.updatedAt,
            })
            .returning();
          if (!created) {
            throw new Error(
              `Failed to migrate GitHub integration for project ${old.projectId}`,
            );
          }
          desiredActiveByIntegrationId.set(created.id, old.isActive ?? true);
          migratedCount++;
        }
      }

      await repairGitHubRepositoryBindings(tx, {
        desiredActiveByIntegrationId,
      });

      console.log(`✓ Migrated ${migratedCount} integrations`);

      await migrateTaskLinks(tx);
      await dropOldTable(tx);
    });

    console.log("✅ GitHub integration migration complete!");
  } catch (error) {
    console.error("Failed to migrate GitHub integration:", error);
    throw error;
  }
}

async function migrateTaskLinks(tx: MigrationClient) {
  console.log("🔄 Migrating task links from descriptions...");

  const tasks = await tx.query.taskTable.findMany();

  let linksCreated = 0;
  let descriptionsUpdated = 0;

  for (const task of tasks) {
    if (!task.description) continue;

    const linkMatch = task.description.match(
      /(Linked to|Created from) GitHub issue: (https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+))/,
    );

    if (!linkMatch) continue;

    const linkType = linkMatch[1];
    const url = linkMatch[2];
    const owner = linkMatch[3];
    const repo = linkMatch[4];
    const issueNumber = linkMatch[5];

    if (!url || !owner || !repo || !issueNumber) continue;

    const integration = await tx.query.integrationTable.findFirst({
      where: and(
        eq(integrationTable.projectId, task.projectId),
        eq(integrationTable.type, "github"),
      ),
    });

    if (!integration) continue;

    const config = JSON.parse(integration.config);
    if (config.repositoryOwner !== owner || config.repositoryName !== repo) {
      continue;
    }

    const existingLink = await tx.query.externalLinkTable.findFirst({
      where: and(
        eq(externalLinkTable.taskId, task.id),
        eq(externalLinkTable.integrationId, integration.id),
        eq(externalLinkTable.resourceType, "issue"),
      ),
    });

    if (!existingLink) {
      await tx.insert(externalLinkTable).values({
        taskId: task.id,
        integrationId: integration.id,
        resourceType: "issue",
        externalId: issueNumber,
        url: url,
        title: null,
        metadata: JSON.stringify({
          migrated: true,
          createdFrom: linkType === "Created from" ? "github" : "kaneo",
        }),
      });
      linksCreated++;
    }

    const cleanedDescription = task.description
      .replace(/\n\n---\n\n\*.*GitHub issue:.*\*/g, "")
      .replace(/\n---\n<sub>Task:.*<\/sub>/g, "")
      .trim();

    if (cleanedDescription !== task.description) {
      await tx
        .update(taskTable)
        .set({ description: cleanedDescription || null })
        .where(eq(taskTable.id, task.id));
      descriptionsUpdated++;
    }
  }

  console.log(`✓ Created ${linksCreated} external links`);
  console.log(`✓ Cleaned ${descriptionsUpdated} task descriptions`);
}

async function dropOldTable(tx: Pick<DatabaseTransaction, "execute">) {
  console.log("🗑️ Dropping old github_integration table...");
  await tx.execute(sql`DROP TABLE IF EXISTS github_integration CASCADE`);
  console.log("✓ Dropped github_integration table");
}
