import { eq } from "drizzle-orm";
import * as v from "valibot";
import db from "../../../database";
import { taskTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import { createGiteaLabelLoader } from "../../../gitea-integration/controllers/import-gitea-issues";
import { findExternalLink } from "../../github/services/link-manager";
import { updateTaskStatus } from "../../github/services/task-service";
import {
  extractIssuePriority,
  extractIssueStatus,
} from "../../github/utils/extract-priority";
import { type GiteaConfig, giteaConfigSchema } from "../config";
import {
  findAllIntegrationsByGiteaRepo,
  repoOwnerLogin,
} from "../services/integration-lookup";
import { createGiteaClient } from "../utils/gitea-api";
import { isSystemLabelName } from "../utils/system-labels";
import { baseUrlFromRepositoryHtmlUrl } from "../utils/webhook-repo";
import { reconcileGiteaIssueLabels } from "./reconcile-issue-labels";

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

const LABEL_RECONCILE_ACTIONS = new Set([
  "labeled",
  "unlabeled",
  "label_updated",
]);

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
  const { issue, repository } = payload;

  const baseUrl = baseUrlFromRepositoryHtmlUrl(repository.html_url);
  if (!baseUrl) return;

  const owner = repoOwnerLogin(repository);
  const integrations = await findAllIntegrationsByGiteaRepo(
    baseUrl,
    owner,
    repository.name,
    integrationId,
  );

  for (const integration of integrations) {
    try {
      const existingLink = await findExternalLink(
        integration.id,
        "issue",
        issue.number.toString(),
      );

      if (!existingLink) {
        continue;
      }

      const priority = extractIssuePriority(issue.labels);
      const status = extractIssueStatus(issue.labels);

      if (priority) {
        await db
          .update(taskTable)
          .set({ priority })
          .where(eq(taskTable.id, existingLink.taskId));
      }

      if (status) {
        const statusResult = await updateTaskStatus(
          existingLink.taskId,
          status,
        );
        if (
          statusResult.applied &&
          statusResult.before.status !== statusResult.after.status
        ) {
          await publishEvent("task.status_changed", {
            taskId: statusResult.after.id,
            projectId: statusResult.after.projectId,
            userId: null,
            oldStatus: statusResult.before.status,
            newStatus: statusResult.after.status,
            title: statusResult.after.title,
            assigneeId: statusResult.after.userId,
            type: "status_changed",
          });
        }
      }

      if (!LABEL_RECONCILE_ACTIONS.has(payload.action)) {
        continue;
      }

      const config = parseStrictGiteaConfig(integration.config);
      if (!config) {
        continue;
      }

      const task = await db.query.taskTable.findFirst({
        where: eq(taskTable.id, existingLink.taskId),
        with: {
          project: true,
        },
      });
      if (!task?.project?.workspaceId) {
        continue;
      }

      const client = createGiteaClient(config);
      const loader = createGiteaLabelLoader(client, config, issue.number);
      const { assigned, unassigned } = await reconcileGiteaIssueLabels(
        existingLink.taskId,
        task.project.workspaceId,
        payloadLabelNames(payload),
        loader,
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
      console.error("Gitea issue_labeled handler failed for integration", {
        integrationId: integration.id,
        issueNumber: issue.number,
        repository: `${owner}/${repository.name}`,
        error,
      });
    }
  }
}
