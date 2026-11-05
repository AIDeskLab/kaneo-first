import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";
import db from "../../../database";
import { labelTable, taskTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import {
  findExternalLink,
  updateExternalLink,
} from "../../github/services/link-manager";
import {
  type IntegrationDatabase,
  linkedTaskScope,
} from "../../github/services/integration-task-scope";
import { withIntegrationLink } from "../../github/services/with-integration-link";
import { acceptsIssue, readSyncRules } from "../../sync/rules";
import { resumeLabelChanges } from "../../sync/resume-label-changes";
import {
  labelReadDeadline,
  syncLabelFieldsFromIssue,
} from "../../sync/sync-label-fields-from-issue";
import { type GiteaConfig, giteaConfigSchema } from "../config";
import {
  findAllIntegrationsByGiteaRepo,
  repoOwnerLogin,
} from "../services/integration-lookup";
import { createGiteaClient } from "../utils/gitea-api";
import { isSystemLabelName } from "../utils/system-labels";
import { baseUrlFromRepositoryHtmlUrl } from "../utils/webhook-repo";
import { handleGiteaIssueOpened } from "./issue-opened";
import {
  type GiteaLabelLoader,
  reconcileGiteaIssueLabels,
} from "./reconcile-issue-labels";

function createGiteaLabelLoader(
  client: ReturnType<typeof createGiteaClient>,
  config: GiteaConfig,
  issueNumber: number,
): GiteaLabelLoader {
  return async () => {
    const issue = await client.getIssue(
      config.repositoryOwner,
      config.repositoryName,
      issueNumber,
    );
    return issue.labels ?? [];
  };
}

type IssueLabeledPayload = {
  action: string;
  issue: {
    number: number;
    labels?: Array<string | { name?: string; color?: string }>;
  };
  label?: {
    name: string;
    color: string;
  };
  repository: {
    owner: { login?: string; username?: string };
    name: string;
    html_url: string;
  };
};

function giteaLabelsForSync(
  labels: IssueLabeledPayload["issue"]["labels"],
): Array<{ name: string; color?: string }> {
  if (!labels) return [];
  const out: Array<{ name: string; color?: string }> = [];
  for (const raw of labels) {
    const name = typeof raw === "string" ? raw : raw.name;
    if (!name || isSystemLabelName(name)) continue;
    const color =
      typeof raw === "object" && raw && "color" in raw ? raw.color : undefined;
    out.push({ name, color });
  }
  return out;
}

function normalizedGiteaLabelColor(g: { color?: string }): string {
  return g.color ? `#${g.color.replace(/^#/, "")}` : "#6B7280";
}

async function syncGiteaLabelsToTask(
  taskId: string,
  workspaceId: string,
  giteaLabels: Array<{ name: string; color?: string }>,
  database: IntegrationDatabase,
  previousNames?: string[],
) {
  const desiredNames = new Set(giteaLabels.map((label) => label.name));
  const previous = previousNames ? new Set(previousNames) : undefined;
  const existingRows = await database.query.labelTable.findMany({
    where: eq(labelTable.taskId, taskId),
  });

  const labelsToInsert = giteaLabels
    .filter(
      (label) =>
        (!previous || !previous.has(label.name)) &&
        !existingRows.some((row) => row.name === label.name),
    )
    .map((label) => ({
      name: label.name,
      color: normalizedGiteaLabelColor(label),
      taskId,
      workspaceId,
    }));

  const colorToIds = new Map<string, string[]>();
  for (const label of giteaLabels) {
    if (isSystemLabelName(label.name)) continue;
    const row = existingRows.find((existing) => existing.name === label.name);
    if (!row) continue;
    const want = normalizedGiteaLabelColor(label);
    const have = row.color ? `#${row.color.replace(/^#/, "")}` : "#6B7280";
    if (have === want) continue;
    const list = colorToIds.get(want) ?? [];
    list.push(row.id);
    colorToIds.set(want, list);
  }

  for (const [color, ids] of colorToIds) {
    if (ids.length === 0) continue;
    await database
      .update(labelTable)
      .set({ color })
      .where(inArray(labelTable.id, ids));
  }

  if (labelsToInsert.length > 0) {
    await database
      .insert(labelTable)
      .values(labelsToInsert)
      .onConflictDoNothing({
        target: [labelTable.taskId, labelTable.name],
      });
  }

  const labelsToDelete = existingRows
    .filter(
      (row) =>
        (!previous || previous.has(row.name)) &&
        !desiredNames.has(row.name) &&
        !isSystemLabelName(row.name),
    )
    .map((row) => row.id);

  if (labelsToDelete.length > 0) {
    await database
      .delete(labelTable)
      .where(inArray(labelTable.id, labelsToDelete));
  }
}

function parseStrictGiteaConfig(raw: string): GiteaConfig | null {
  try {
    return v.parse(giteaConfigSchema, JSON.parse(raw));
  } catch (error) {
    console.warn("[Gitea Webhook] Invalid integration config", { error });
    return null;
  }
}

function payloadLabelNames(payload: IssueLabeledPayload): string[] {
  const names: string[] = [];
  if (payload.label?.name && !isSystemLabelName(payload.label.name)) {
    names.push(payload.label.name);
  }
  if (payload.issue.labels) {
    for (const raw of payload.issue.labels) {
      const name = typeof raw === "string" ? raw : raw.name;
      if (name && !isSystemLabelName(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

export async function handleGiteaIssueLabeled(
  payload: IssueLabeledPayload,
  integrationId?: string,
) {
  const { issue, repository, label: addedLabel } = payload;

  const baseUrl = baseUrlFromRepositoryHtmlUrl(repository.html_url);
  if (!baseUrl) return;

  const owner = repoOwnerLogin(repository);
  const integrations = await findAllIntegrationsByGiteaRepo(
    baseUrl,
    owner,
    repository.name,
    integrationId,
  );
  const deadline = labelReadDeadline();

  for (const integration of integrations) {
    try {
      const existingLink = await findExternalLink(
        integration.id,
        "issue",
        issue.number.toString(),
      );

      if (!existingLink) {
        const fullIssue = issue as typeof issue &
          Partial<Parameters<typeof handleGiteaIssueOpened>[0]["issue"]>;
        if (
          ["label_updated", "labeled"].includes(payload.action) &&
          readSyncRules(integration.config)?.incoming.mode === "labels" &&
          acceptsIssue(integration.config, issue.labels) &&
          fullIssue.title &&
          fullIssue.html_url
        ) {
          await handleGiteaIssueOpened(
            payload as Parameters<typeof handleGiteaIssueOpened>[0],
            integration.id,
          );
        }
        continue;
      }

      const fieldEvent = !addedLabel || isSystemLabelName(addedLabel.name);
      if (fieldEvent) {
        await syncLabelFieldsFromIssue(
          integration,
          existingLink,
          undefined,
          deadline,
        );
      }

      if (payload.action === "label_updated") {
        await withIntegrationLink(
          existingLink,
          integration,
          async (database, afterCommit, link) => {
            const names = (issue.labels ?? []).flatMap((label) => {
              const name = typeof label === "string" ? label : label.name;
              return name ? [name] : [];
            });
            const changes = resumeLabelChanges(link, names);
            if (changes.baseline && issue.labels !== undefined) {
              await updateExternalLink(
                link.id,
                { metadata: { syncResumeLabelBaseline: names } },
                database,
              );
            }
            if (issue.labels === undefined) return;

            const task = await database.query.taskTable.findFirst({
              where: linkedTaskScope(link.taskId, integration.projectId),
              with: { project: true },
            });
            if (!task?.project?.workspaceId) return;
            await syncGiteaLabelsToTask(
              link.taskId,
              task.project.workspaceId,
              giteaLabelsForSync(issue.labels),
              database,
              changes.baseline,
            );
            afterCommit(() =>
              publishEvent("task.labels_updated", {
                projectId: integration.projectId,
                taskId: link.taskId,
              }),
            );
          },
        );
        continue;
      }

      if (fieldEvent) continue;

      const config = parseStrictGiteaConfig(integration.config);
      if (!config) continue;

      try {
        const task = await db.query.taskTable.findFirst({
          where: eq(taskTable.id, existingLink.taskId),
          with: { project: true },
        });
        if (!task?.project?.workspaceId) continue;
        const client = createGiteaClient(config);
        const { assigned, unassigned } = await reconcileGiteaIssueLabels(
          existingLink.taskId,
          task.project.workspaceId,
          payloadLabelNames(payload),
          createGiteaLabelLoader(client, config, issue.number),
        );
        const taskContext = {
          id: task.id,
          projectId: task.projectId,
          workspaceId: task.project.workspaceId,
        };
        for (const label of assigned) {
          await publishEvent("task.label_assigned", {
            label,
            task: taskContext,
            projectId: task.projectId,
            taskId: task.id,
            userId: null,
            type: "label_assigned",
          });
        }
        for (const label of unassigned) {
          await publishEvent("task.label_unassigned", {
            label,
            task: taskContext,
            projectId: task.projectId,
            taskId: task.id,
            userId: null,
            type: "label_unassigned",
          });
        }
      } catch (error) {
        console.error("Gitea label reconciliation failed", {
          integrationId: integration.id,
          issueNumber: issue.number,
          error,
        });
        await applyPayloadLabelChange(payload, existingLink, integration);
      }
    } catch (error) {
      console.error("Gitea issue_labeled handler failed for integration", {
        integrationId: integration.id,
        issueNumber: issue.number,
        repository: `${owner}/${repository.name}`,
        error,
      });
    }
  }
}

async function applyPayloadLabelChange(
  payload: IssueLabeledPayload,
  existingLink: { id: string; taskId: string },
  integration: { id: string; projectId: string; config: string },
) {
  const addedLabel = payload.label;
  if (!addedLabel || isSystemLabelName(addedLabel.name)) return;
  await withIntegrationLink(
    existingLink,
    integration,
    async (database, afterCommit, link) => {
      if (payload.action === "labeled") {
        const task = await database.query.taskTable.findFirst({
          where: linkedTaskScope(link.taskId, integration.projectId),
          with: { project: true },
        });
        if (task?.project?.workspaceId) {
          const existingLabel = await database.query.labelTable.findFirst({
            where: (table, { and, eq: equals }) =>
              and(
                equals(table.workspaceId, task.project.workspaceId),
                equals(table.name, addedLabel.name),
                equals(table.taskId, task.id),
              ),
          });
          if (!existingLabel) {
            const color = addedLabel.color
              ? `#${addedLabel.color.replace(/^#/, "")}`
              : "#6B7280";
            await database
              .insert(labelTable)
              .values({
                name: addedLabel.name,
                color,
                taskId: task.id,
                workspaceId: task.project.workspaceId,
              })
              .onConflictDoNothing({
                target: [labelTable.taskId, labelTable.name],
              });
          }
        }
      }

      if (payload.action === "unlabeled") {
        const labelsToDelete = await database.query.labelTable.findMany({
          where: (table, { and, eq: equals }) =>
            and(
              equals(table.taskId, link.taskId),
              equals(table.name, addedLabel.name),
            ),
        });
        for (const label of labelsToDelete) {
          await database.delete(labelTable).where(eq(labelTable.id, label.id));
        }
      }

      afterCommit(() =>
        publishEvent("task.labels_updated", {
          projectId: integration.projectId,
          taskId: link.taskId,
        }),
      );
    },
  );
}
