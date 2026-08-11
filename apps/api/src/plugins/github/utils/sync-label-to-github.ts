import { eq } from "drizzle-orm";
import db from "../../../database";
import { externalLinkTable } from "../../../database/schema";
import { getInstallationOctokit } from "./github-app";
import { removeLabel } from "./labels";

const namedColorToHex: Record<string, string> = {
  red: "EF4444",
  orange: "F97316",
  amber: "F59E0B",
  yellow: "EAB308",
  lime: "84CC16",
  green: "22C55E",
  emerald: "10B981",
  teal: "14B8A6",
  cyan: "06B6D4",
  sky: "0EA5E9",
  blue: "3B82F6",
  indigo: "6366F1",
  violet: "8B5CF6",
  purple: "A855F7",
  fuchsia: "D946EF",
  pink: "EC4899",
  rose: "F43F5E",
  gray: "6B7280",
  slate: "64748B",
  zinc: "71717A",
  neutral: "737373",
  stone: "78716C",
};

function toHexColor(color: string): string {
  const lower = color.toLowerCase().replace(/^#/, "");
  if (namedColorToHex[lower]) {
    return namedColorToHex[lower];
  }
  if (/^[0-9a-f]{6}$/i.test(lower)) {
    return lower;
  }
  if (/^[0-9a-f]{3}$/i.test(lower)) {
    const [r, g, b] = lower.split("");
    return `${r}${r}${g}${g}${b}${b}`;
  }
  return "6B7280";
}

function getExternalLinksWithIntegration(taskId: string) {
  return db.query.externalLinkTable.findMany({
    where: eq(externalLinkTable.taskId, taskId),
    with: {
      integration: true,
    },
  });
}

async function getGitHubContexts(taskId: string) {
  const externalLinks = await getExternalLinksWithIntegration(taskId);
  return getGitHubContextsFromLinks(externalLinks);
}

async function getGitHubContextsFromLinks(
  externalLinks: Awaited<ReturnType<typeof getExternalLinksWithIntegration>>,
) {
  const applicableLinks = externalLinks.filter(
    (link) =>
      link.resourceType === "issue" && link.integration?.type === "github",
  );

  const contexts = [];
  for (const externalLink of applicableLinks) {
    const integration = externalLink.integration;
    if (!integration) throw new Error("GitHub integration is missing");

    let config: unknown;
    try {
      config = JSON.parse(integration.config);
    } catch {
      throw new Error("GitHub integration config is malformed");
    }
    if (!config || typeof config !== "object") {
      throw new Error("GitHub integration config is malformed");
    }
    const { repositoryOwner, repositoryName, installationId } = config as {
      repositoryOwner?: unknown;
      repositoryName?: unknown;
      installationId?: unknown;
    };
    if (
      typeof repositoryOwner !== "string" ||
      !repositoryOwner.trim() ||
      typeof repositoryName !== "string" ||
      !repositoryName.trim() ||
      typeof installationId !== "number" ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    ) {
      throw new Error("GitHub integration config is incomplete");
    }
    const issueNumber = Number(externalLink.externalId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("GitHub issue external ID is invalid");
    }
    const octokit = await getInstallationOctokit(installationId);
    if (!octokit) throw new Error("GitHub client could not be created");
    contexts.push({
      octokit,
      owner: repositoryOwner,
      repo: repositoryName,
      issueNumber,
    });
  }
  return contexts;
}

export async function syncLabelToGitHub(
  taskId: string,
  labelName: string,
  labelColor: string,
) {
  const contexts = await getGitHubContexts(taskId);
  const color = toHexColor(labelColor);
  for (const { octokit, owner, repo, issueNumber } of contexts) {
    try {
      await octokit.rest.issues.getLabel({ owner, repo, name: labelName });
    } catch {
      try {
        await octokit.rest.issues.createLabel({
          owner,
          repo,
          name: labelName,
          color,
        });
      } catch (createError: unknown) {
        if (
          !(
            typeof createError === "object" &&
            createError !== null &&
            "status" in createError &&
            createError.status === 422
          )
        ) {
          throw createError;
        }
      }
    }
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [labelName],
    });
  }
}

export async function removeLabelFromGitHub(taskId: string, labelName: string) {
  const contexts = await getGitHubContexts(taskId);
  for (const { octokit, owner, repo, issueNumber } of contexts) {
    await removeLabel(octokit, owner, repo, issueNumber, labelName);
  }
}
