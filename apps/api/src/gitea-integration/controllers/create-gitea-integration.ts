import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import db from "../../database";
import { integrationTable, projectTable } from "../../database/schema";
import {
  type GiteaConfig,
  getDefaultGiteaConfig,
  normalizeGiteaBaseUrl,
  validateGiteaConfig,
} from "../../plugins/gitea/config";
import {
  createGiteaClient,
  GiteaApiError,
  verifyGiteaToken,
} from "../../plugins/gitea/utils/gitea-api";

const GITEA_BINDING_LOCK_NAMESPACE = 1534;

async function createGiteaIntegration({
  projectId,
  baseUrl,
  accessToken,
  repositoryOwner,
  repositoryName,
}: {
  projectId: string;
  baseUrl: string;
  accessToken: string | undefined;
  repositoryOwner: string;
  repositoryName: string;
}) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const normalizedBase = normalizeGiteaBaseUrl(baseUrl);

  const existingIntegration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, projectId),
      eq(integrationTable.type, "gitea"),
    ),
  });

  let resolvedToken = accessToken?.trim() ?? "";
  if (!resolvedToken && existingIntegration) {
    try {
      const prev = JSON.parse(existingIntegration.config) as GiteaConfig;
      resolvedToken = prev.accessToken;
    } catch (error) {
      console.warn("Failed to parse existing Gitea integration config", {
        integrationId: existingIntegration.id,
        error,
      });
    }
  }

  if (!resolvedToken) {
    throw new HTTPException(400, {
      message: "Personal access token is required",
    });
  }

  try {
    await verifyGiteaToken(normalizedBase, resolvedToken);

    const client = createGiteaClient({
      baseUrl: normalizedBase,
      accessToken: resolvedToken,
    });
    await client.getRepo(repositoryOwner, repositoryName);
  } catch (error) {
    if (error instanceof GiteaApiError) {
      throw new HTTPException((error.status || 400) as ContentfulStatusCode, {
        message: error.message,
      });
    }
    throw error;
  }

  const lockKey = `gitea:${normalizedBase.toLowerCase().replace(/\/+$/, "")}:${repositoryOwner.trim().toLowerCase()}/${repositoryName.trim().toLowerCase()}`;

  const normalizedOwner = repositoryOwner.trim().toLowerCase();
  const normalizedName = repositoryName.trim().toLowerCase();

  const { integration: integrationResult, webhookSecret } =
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${GITEA_BINDING_LOCK_NAMESPACE}, hashtext(${lockKey}))`,
      );

      const allGitea = await tx.query.integrationTable.findMany({
        where: eq(integrationTable.type, "gitea"),
      });

      for (const integration of allGitea) {
        if (integration.projectId === projectId) {
          continue;
        }
        if (!integration.isActive) {
          continue;
        }
        try {
          const cfg = JSON.parse(integration.config) as {
            baseUrl?: string;
            repositoryOwner?: string;
            repositoryName?: string;
          };
          if (
            normalizeGiteaBaseUrl(cfg.baseUrl ?? "") === normalizedBase &&
            cfg.repositoryOwner?.trim().toLowerCase() === normalizedOwner &&
            cfg.repositoryName?.trim().toLowerCase() === normalizedName
          ) {
            throw new HTTPException(409, {
              message: `Repository ${repositoryOwner}/${repositoryName} on this Gitea instance is already linked to another project`,
            });
          }
        } catch (error) {
          if (error instanceof HTTPException) {
            throw error;
          }
          console.warn(
            "Skipping invalid Gitea integration config during conflict check",
            {
              integrationId: integration.id,
              error,
            },
          );
        }
      }

      const projectGiteaIntegration = await tx.query.integrationTable.findFirst(
        {
          where: and(
            eq(integrationTable.projectId, projectId),
            eq(integrationTable.type, "gitea"),
          ),
        },
      );

      let resolvedWebhookSecret = randomBytes(24).toString("hex");
      if (projectGiteaIntegration) {
        try {
          const previousConfig = JSON.parse(
            projectGiteaIntegration.config,
          ) as GiteaConfig;
          resolvedWebhookSecret =
            previousConfig.webhookSecret ?? resolvedWebhookSecret;
        } catch (error) {
          console.warn(
            "Failed to parse existing Gitea config for webhook secret",
            {
              integrationId: projectGiteaIntegration.id,
              error,
            },
          );
        }
      }

      const config: GiteaConfig = getDefaultGiteaConfig(
        normalizedBase,
        resolvedToken,
        repositoryOwner,
        repositoryName,
        resolvedWebhookSecret,
      );

      const validation = await validateGiteaConfig(config);
      if (!validation.valid) {
        throw new HTTPException(400, {
          message: validation.errors?.join(", ") ?? "Invalid config",
        });
      }

      if (projectGiteaIntegration) {
        const [updated] = await tx
          .update(integrationTable)
          .set({
            config: JSON.stringify(config),
            isActive: true,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(integrationTable.projectId, projectId),
              eq(integrationTable.type, "gitea"),
            ),
          )
          .returning();

        if (!updated) {
          throw new HTTPException(500, {
            message: "Failed to update Gitea integration",
          });
        }

        return { integration: updated, webhookSecret: resolvedWebhookSecret };
      }

      const [newIntegration] = await tx
        .insert(integrationTable)
        .values({
          projectId,
          type: "gitea",
          config: JSON.stringify(config),
          isActive: true,
        })
        .returning();

      if (!newIntegration) {
        throw new HTTPException(500, {
          message: "Failed to create Gitea integration",
        });
      }

      return {
        integration: newIntegration,
        webhookSecret: resolvedWebhookSecret,
      };
    });

  return {
    id: integrationResult.id,
    projectId: integrationResult.projectId,
    baseUrl: normalizedBase,
    repositoryOwner,
    repositoryName,
    webhookSecret,
    isActive: integrationResult.isActive,
    createdAt: integrationResult.createdAt,
    updatedAt: integrationResult.updatedAt,
  };
}

export default createGiteaIntegration;
