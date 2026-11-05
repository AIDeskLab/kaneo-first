import { and, eq, ne } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import db from "../../database";
import { integrationTable, projectTable } from "../../database/schema";
import {
  defaultGitHubConfig,
  githubConfigSchema,
} from "../../plugins/github/config";
import { getGithubApp } from "../../plugins/github/utils/github-app";
import {
  isPostgresUniqueViolation,
  normalizeGitHubRepositoryKey,
} from "../github-repository-key";
import { verifyRepositoryOwner } from "./verify-repository-owner";

async function assertRepositoryKeyAvailable(
  repositoryKey: string,
  projectId: string,
  canonicalOwner: string,
  canonicalName: string,
) {
  const conflictingBinding = await db.query.integrationTable.findFirst({
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
}

async function createGithubIntegration({
  userId,
  projectId,
  repositoryOwner,
  repositoryName,
}: {
  userId?: string;
  projectId: string;
  repositoryOwner: string;
  repositoryName: string;
}) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  if (!userId) {
    return createUnverifiedGithubIntegration({
      projectId,
      repositoryOwner,
      repositoryName,
    });
  }

  const binding = await verifyRepositoryOwner(
    userId,
    repositoryOwner,
    repositoryName,
  );
  const { installationId } = binding;
  const githubRepositoryKey = normalizeGitHubRepositoryKey(
    binding.repositoryOwner,
    binding.repositoryName,
  );

  const existingIntegration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, projectId),
      eq(integrationTable.type, "github"),
    ),
  });

  let previousConfig = {};
  if (existingIntegration) {
    let previous: unknown;
    try {
      previous = JSON.parse(existingIntegration.config);
    } catch {
      previous = null;
    }
    const parsed = v.safeParse(githubConfigSchema, previous);
    const sameRepository =
      parsed.success &&
      (parsed.output.repositoryId !== undefined
        ? parsed.output.repositoryId === binding.repositoryId
        : parsed.output.repositoryOwner.toLowerCase() ===
            binding.repositoryOwner.toLowerCase() &&
          parsed.output.repositoryName.toLowerCase() ===
            binding.repositoryName.toLowerCase());
    if (!sameRepository) {
      // External issue/PR numbers are scoped to a repository. Reusing this
      // integration ID would reinterpret its existing links in another repo.
      throw new HTTPException(409, {
        message:
          "Disconnect the current GitHub integration before connecting a different repository",
      });
    }
    if (parsed.success) previousConfig = parsed.output;
  }
  const config = { ...defaultGitHubConfig, ...previousConfig, ...binding };
  await assertRepositoryKeyAvailable(
    githubRepositoryKey,
    projectId,
    binding.repositoryOwner,
    binding.repositoryName,
  );

  if (existingIntegration) {
    const [updatedIntegration] = await db
      .update(integrationTable)
      .set({
        config: JSON.stringify(config),
        githubRepositoryKey,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationTable.id, existingIntegration.id),
          eq(integrationTable.config, existingIntegration.config),
        ),
      )
      .returning();

    if (!updatedIntegration)
      throw new HTTPException(409, {
        message: "GitHub integration changed; refresh before reconnecting",
      });

    return {
      id: updatedIntegration.id,
      projectId: updatedIntegration?.projectId,
      repositoryOwner: binding.repositoryOwner,
      repositoryName: binding.repositoryName,
      installationId,
      requiresVerification: false,
      isActive: updatedIntegration?.isActive,
      createdAt: updatedIntegration?.createdAt,
      updatedAt: updatedIntegration?.updatedAt,
    };
  }

  const [newIntegration] = await db
    .insert(integrationTable)
    .values({
      projectId,
      type: "github",
      config: JSON.stringify(config),
      githubRepositoryKey,
      isActive: true,
    })
    .returning();

  if (!newIntegration) {
    throw new HTTPException(500, {
      message: "Failed to create GitHub integration",
    });
  }

  return {
    id: newIntegration?.id,
    projectId: newIntegration?.projectId,
    repositoryOwner: binding.repositoryOwner,
    repositoryName: binding.repositoryName,
    installationId,
    requiresVerification: false,
    isActive: newIntegration?.isActive,
    createdAt: newIntegration?.createdAt,
    updatedAt: newIntegration?.updatedAt,
  };
}

async function createUnverifiedGithubIntegration({
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
  const githubRepositoryKey = normalizeGitHubRepositoryKey(
    canonicalOwner,
    canonicalName,
  );
  if (!githubRepositoryKey) {
    throw new HTTPException(400, {
      message: "Repository owner and name are required",
    });
  }
  if (!githubApp) {
    throw new HTTPException(500, { message: "GitHub app not configured" });
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
    throw new HTTPException(403, {
      message: "Could not access the GitHub repository",
    });
  }

  await assertRepositoryKeyAvailable(
    githubRepositoryKey,
    projectId,
    canonicalOwner,
    canonicalName,
  );

  const config = {
    repositoryOwner: canonicalOwner,
    repositoryName: canonicalName,
    installationId,
    ...defaultGitHubConfig,
  };

  try {
    const [created] = await db
      .insert(integrationTable)
      .values({
        projectId,
        type: "github",
        config: JSON.stringify(config),
        githubRepositoryKey,
        isActive: true,
      })
      .returning();
    return {
      id: created?.id,
      projectId: created?.projectId,
      repositoryOwner: canonicalOwner,
      repositoryName: canonicalName,
      installationId,
      requiresVerification: false,
      isActive: created?.isActive,
      createdAt: created?.createdAt,
      updatedAt: created?.updatedAt,
    };
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new HTTPException(409, {
        message: `Repository ${canonicalOwner}/${canonicalName} is already linked to another project`,
      });
    }
    throw error;
  }
}

export default createGithubIntegration;
