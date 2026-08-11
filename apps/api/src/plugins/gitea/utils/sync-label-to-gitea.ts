import { eq } from "drizzle-orm";
import db from "../../../database";
import { externalLinkTable } from "../../../database/schema";
import type { GiteaConfig } from "../config";
import { normalizeGiteaBaseUrl } from "../config";
import { createGiteaClient, GiteaApiError } from "./gitea-api";

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

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

async function getGiteaIssueContexts(taskId: string) {
  const externalLinks = await db.query.externalLinkTable.findMany({
    where: eq(externalLinkTable.taskId, taskId),
    with: {
      integration: true,
    },
  });

  const applicableLinks = externalLinks.filter(
    (link) =>
      link.resourceType === "issue" && link.integration?.type === "gitea",
  );

  const contexts = [];
  for (const externalLink of applicableLinks) {
    const integration = externalLink.integration;
    if (!integration) throw new Error("Gitea integration is missing");
    let parsed: unknown;
    try {
      parsed = JSON.parse(integration.config);
    } catch {
      throw new Error("Gitea integration config is malformed");
    }
    const fields = parsed as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !isNonBlankString(fields.accessToken) ||
      !isNonBlankString(fields.baseUrl) ||
      !isNonBlankString(fields.repositoryOwner) ||
      !isNonBlankString(fields.repositoryName)
    ) {
      throw new Error("Gitea integration config is incomplete");
    }
    const config = parsed as GiteaConfig;
    try {
      normalizeGiteaBaseUrl(config.baseUrl);
    } catch {
      throw new Error("Gitea integration config is incomplete");
    }
    const issueNumber = Number(externalLink.externalId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
      throw new Error("Gitea issue external ID is invalid");
    contexts.push({ client: createGiteaClient(config), config, issueNumber });
  }
  return contexts;
}

export async function syncLabelToGitea(
  taskId: string,
  labelName: string,
  labelColor: string,
) {
  const contexts = await getGiteaIssueContexts(taskId);
  const color = toHexColor(labelColor);
  for (const { client, config, issueNumber } of contexts) {
    const labels = await client.listLabels(
      config.repositoryOwner,
      config.repositoryName,
    );
    let label = labels.find((l) => l.name === labelName);

    if (!label) {
      try {
        label = await client.createLabel(
          config.repositoryOwner,
          config.repositoryName,
          labelName,
          color,
        );
      } catch (error) {
        if (!(error instanceof GiteaApiError && error.status === 409))
          throw error;
        const refreshed = await client.listLabels(
          config.repositoryOwner,
          config.repositoryName,
        );
        label = refreshed.find((candidate) => candidate.name === labelName);
        if (!label) throw error;
      }
    }

    const issue = await client.getIssue(
      config.repositoryOwner,
      config.repositoryName,
      issueNumber,
    );
    const existingIds = (issue.labels ?? []).map((l) => l.id);
    if (existingIds.includes(label.id)) {
      continue;
    }
    await client.addLabelsToIssue(
      config.repositoryOwner,
      config.repositoryName,
      issueNumber,
      [label.id],
    );
  }
}

export async function removeLabelFromGitea(taskId: string, labelName: string) {
  const externalLinks = await db.query.externalLinkTable.findMany({
    where: eq(externalLinkTable.taskId, taskId),
    with: { integration: true },
  });
  const applicableLinks = externalLinks.filter(
    (link) =>
      link.resourceType === "issue" && link.integration?.type === "gitea",
  );

  for (const externalLink of applicableLinks) {
    const integration = externalLink.integration;
    if (!integration) throw new Error("Gitea integration is missing");
    let config: GiteaConfig;
    try {
      config = JSON.parse(integration.config) as GiteaConfig;
    } catch {
      throw new Error("Gitea integration config is malformed");
    }
    if (
      !config ||
      typeof config.accessToken !== "string" ||
      !config.accessToken ||
      typeof config.baseUrl !== "string" ||
      !config.baseUrl ||
      typeof config.repositoryOwner !== "string" ||
      !config.repositoryOwner ||
      typeof config.repositoryName !== "string" ||
      !config.repositoryName
    ) {
      throw new Error("Gitea integration config is incomplete");
    }
    const issueNumber = Number(externalLink.externalId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Gitea issue external ID is invalid");
    }
    const client = createGiteaClient(config);
    if (!client) throw new Error("Gitea client could not be created");
    const labels = await client.listLabels(
      config.repositoryOwner,
      config.repositoryName,
    );
    const label = labels.find((candidate) => candidate.name === labelName);
    if (!label) continue;
    try {
      await client.removeLabelFromIssue(
        config.repositoryOwner,
        config.repositoryName,
        issueNumber,
        label.id,
      );
    } catch (error) {
      if (error instanceof GiteaApiError && error.status === 404) continue;
      throw error;
    }
  }
}
