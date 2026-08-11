import { and, eq, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { integrationTable, projectTable } from "../../database/schema";
import { defaultGitHubConfig } from "../../plugins/github/config";
import { getGithubApp } from "../../plugins/github/utils/github-app";
import {
  githubRepositoryKeyFromConfig,
  isPostgresUniqueViolation,
  normalizeGitHubRepositoryKey,
} from "../github-repository-key";

async function createGithubIntegration({
  projectId,
  repositoryOwner,
  repositoryName,
}: {
  projectId: string;
  repositoryOwner: string;
  repositoryName: string;
}) {
  const githubApp = getGithubApp();
  const canonicalOwner = repositoryOwner.trim();
  const canonicalName = repositoryName.trim();
  const repositoryKey = normalizeGitHubRepositoryKey(
    canonicalOwner,
    canonicalName,
  );

  if (!repositoryKey) {
    throw new HTTPException(400, {
      message: "Repository owner and name are required",
    });
  }

  if (!githubApp) {
    throw new HTTPException(500, {
      message: "GitHub app not configured",
    });
  }

  const existingProject = await db.query.projectTable.findFirst({
    columns: { id: true },
    where: eq(projectTable.id, projectId),
  });
  if (!existingProject) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  let installationId: number | null = null;
  try {
    const { data: installation } =
      await githubApp.octokit.rest.apps.getRepoInstallation({
        owner: canonicalOwner,
        repo: canonicalName,
      });
    installationId = installation.id;
  } catch (error) {
    console.warn("Could not get installation ID for repository:", error);
  }

  const config = {
    repositoryOwner: canonicalOwner,
    repositoryName: canonicalName,
    installationId,
    ...defaultGitHubConfig,
  };

  let integration: Awaited<
    ReturnType<typeof db.query.integrationTable.findFirst>
  >;
  try {
    integration = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(1532, hashtext(${`github:${repositoryKey}`}))`,
      );
      const project = await tx.query.projectTable.findFirst({
        where: eq(projectTable.id, projectId),
      });
      if (!project) {
        throw new HTTPException(404, { message: "Project not found" });
      }

      const conflictingBinding = await tx.query.integrationTable.findFirst({
        where: and(
          eq(integrationTable.type, "github"),
          eq(integrationTable.isActive, true),
          eq(integrationTable.githubRepositoryKey, repositoryKey),
          ne(integrationTable.projectId, projectId),
        ),
      });
      if (conflictingBinding) {
        throw new HTTPException(409, {
          message: `Repository ${canonicalOwner}/${canonicalName} is already linked to another project`,
        });
      }

      const existingIntegration = await tx.query.integrationTable.findFirst({
        where: and(
          eq(integrationTable.projectId, projectId),
          eq(integrationTable.type, "github"),
        ),
      });
      if (!existingIntegration) {
        const [created] = await tx
          .insert(integrationTable)
          .values({
            projectId,
            type: "github",
            config: JSON.stringify(config),
            githubRepositoryKey: repositoryKey,
            isActive: true,
          })
          .returning();
        return created;
      }

      const [updated] = await tx
        .update(integrationTable)
        .set({
          config: JSON.stringify(config),
          githubRepositoryKey: repositoryKey,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationTable.projectId, projectId),
            eq(integrationTable.type, "github"),
          ),
        )
        .returning();

      return updated;
    });
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    if (isPostgresUniqueViolation(error)) {
      throw new HTTPException(409, {
        message: `Repository ${canonicalOwner}/${canonicalName} is already linked to another project`,
      });
    }
    throw error;
  }

  return {
    id: integration?.id,
    projectId: integration?.projectId,
    repositoryOwner: canonicalOwner,
    repositoryName: canonicalName,
    installationId,
    isActive: integration?.isActive,
    createdAt: integration?.createdAt,
    updatedAt: integration?.updatedAt,
  };
}

export default createGithubIntegration;
export { githubRepositoryKeyFromConfig };
