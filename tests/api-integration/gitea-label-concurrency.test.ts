import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { importLabelsForTask } from "../../apps/api/src/gitea-integration/controllers/import-gitea-issues";
import deleteLabel from "../../apps/api/src/label/controllers/delete-label";
import { normalizeLabelIdentity } from "../../apps/api/src/label/controllers/workspace-label-lock";
import { handleGiteaIssueLabeled } from "../../apps/api/src/plugins/gitea/webhooks/issue-labeled";
import { reconcileGiteaIssueLabels } from "../../apps/api/src/plugins/gitea/webhooks/reconcile-issue-labels";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import {
  WORKSPACE_LABEL_LOCK_NAMESPACE,
  waitForBlockedLabelMutations,
  withTimeout,
} from "./helpers/label-lock-concurrency";

const mockGetIssue = vi.fn();
const mockCreateGiteaClient = vi.fn();

vi.mock(
  "../../apps/api/src/plugins/gitea/utils/gitea-api",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../apps/api/src/plugins/gitea/utils/gitea-api")
      >();
    return {
      ...actual,
      createGiteaClient: (...args: unknown[]) => {
        mockCreateGiteaClient(...args);
        return {
          getIssue: (...args: unknown[]) => mockGetIssue(...args),
        };
      },
    };
  },
);

const strictGiteaConfig = {
  baseUrl: "https://gitea.example",
  accessToken: "token",
  repositoryOwner: "owner",
  repositoryName: "repo",
};

async function seedMixedSourceFixture() {
  const member = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Mixed labels",
      status: "to-do",
      number: 1,
    })
    .returning();
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "gitea",
      config: JSON.stringify(strictGiteaConfig),
      isActive: true,
    })
    .returning();
  if (!task || !integration) throw new Error("Failed to seed fixtures");

  await db.insert(schema.externalLinkTable).values({
    taskId: task.id,
    integrationId: integration.id,
    resourceType: "issue",
    externalId: "7",
    url: "https://gitea.example/owner/repo/issues/7",
  });
  await db.insert(schema.labelTable).values([
    {
      workspaceId: member.workspace.id,
      taskId: task.id,
      name: "local-only",
      color: "#111111",
      source: "local",
    },
    {
      workspaceId: member.workspace.id,
      taskId: task.id,
      name: "github-owned",
      color: "#222222",
      source: "github",
    },
    {
      workspaceId: member.workspace.id,
      taskId: task.id,
      name: "stale-gitea",
      color: "#333333",
      source: "gitea",
    },
    {
      workspaceId: member.workspace.id,
      taskId: task.id,
      name: "shared-name",
      color: "#444444",
      source: "local",
    },
  ]);

  return {
    member,
    project,
    task,
    integration,
  };
}

describe("Gitea label import concurrency", () => {
  it("cannot resurrect a provider-deleted label during concurrent import", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Import race",
        status: "to-do",
        number: 1,
      })
      .returning();
    const [workspaceLabel] = await db
      .insert(schema.labelTable)
      .values({
        name: "import-race",
        color: "#123456",
        workspaceId: member.workspace.id,
        taskId: null,
      })
      .returning();
    if (!task || !workspaceLabel) throw new Error("Failed to seed fixtures");

    const lockKey = `${member.workspace.id}:${normalizeLabelIdentity(workspaceLabel.name)}`;
    const blocker = await getDatabasePool().connect();
    let lockHeld = false;
    let loaderCalledAfterDelete = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_LABEL_LOCK_NAMESPACE,
        lockKey,
      ]);
      lockHeld = true;

      const deletePromise = deleteLabel(workspaceLabel.id, member.user.id);
      await waitForBlockedLabelMutations(1);

      const importPromise = importLabelsForTask(
        [{ id: 1, name: workspaceLabel.name, color: "abcdef" }],
        task.id,
        member.workspace.id,
        async () => {
          const definition = await db.query.labelTable.findFirst({
            where: eq(schema.labelTable.id, workspaceLabel.id),
          });
          loaderCalledAfterDelete = definition === undefined;
          return [];
        },
      );
      await waitForBlockedLabelMutations(2);

      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_LABEL_LOCK_NAMESPACE,
        lockKey,
      ]);
      lockHeld = false;

      await withTimeout(
        Promise.allSettled([deletePromise, importPromise]),
        10_000,
      );

      expect(loaderCalledAfterDelete).toBe(true);
      await expect(
        db.query.labelTable.findFirst({
          where: eq(schema.labelTable.id, workspaceLabel.id),
        }),
      ).resolves.toBeUndefined();
      const taskLabels = await db.query.labelTable.findMany({
        where: eq(schema.labelTable.taskId, task.id),
      });
      expect(
        taskLabels.some((label) => label.name === workspaceLabel.name),
      ).toBe(false);
    } finally {
      if (lockHeld) {
        await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          WORKSPACE_LABEL_LOCK_NAMESPACE,
          lockKey,
        ]);
      }
      blocker.release();
    }
  }, 20_000);
});

describe("Gitea issue_labeled mixed-source reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["label_updated", [{ name: "fresh-gitea", color: "abcdef" }]],
    ["labeled", [{ name: "fresh-gitea", color: "abcdef" }]],
    ["unlabeled", []],
  ] as const)(
    "preserves local and GitHub-owned labels during %s sync",
    async (_action, providerLabels) => {
      await resetTestDatabase();
      const { task, member } = await seedMixedSourceFixture();

      await reconcileGiteaIssueLabels(
        task.id,
        member.workspace.id,
        providerLabels.map((label) => label.name),
        async () => providerLabels,
      );

      const labels = await db.query.labelTable.findMany({
        where: eq(schema.labelTable.taskId, task.id),
      });
      const names = labels.map((label) => label.name).sort();
      if (providerLabels.length > 0) {
        expect(names).toEqual([
          "fresh-gitea",
          "github-owned",
          "local-only",
          "shared-name",
        ]);
      } else {
        expect(names).toEqual(["github-owned", "local-only", "shared-name"]);
      }
      expect(labels.find((label) => label.name === "shared-name")?.source).toBe(
        "local",
      );
    },
  );

  it("routes labeled webhook events through provider reconciliation", async () => {
    await resetTestDatabase();
    const { task, integration } = await seedMixedSourceFixture();
    mockGetIssue.mockResolvedValue({
      labels: [{ name: "fresh-gitea", color: "abcdef" }],
    });

    await handleGiteaIssueLabeled(
      {
        action: "labeled",
        issue: { number: 7, labels: [{ name: "stale-gitea" }] },
        label: { name: "stale-gitea", color: "333333" },
        repository: {
          owner: { login: "owner" },
          name: "repo",
          html_url: "https://gitea.example/owner/repo",
        },
      },
      integration.id,
    );

    expect(mockCreateGiteaClient).toHaveBeenCalled();
    const labels = await db.query.labelTable.findMany({
      where: eq(schema.labelTable.taskId, task.id),
    });
    expect(labels.map((label) => label.name).sort()).toEqual([
      "fresh-gitea",
      "github-owned",
      "local-only",
      "shared-name",
    ]);
  });

  it("skips reconciliation when integration config is invalid", async () => {
    await resetTestDatabase();
    const { task, integration } = await seedMixedSourceFixture();
    await db
      .update(schema.integrationTable)
      .set({ config: JSON.stringify({ baseUrl: "not-a-url" }) })
      .where(eq(schema.integrationTable.id, integration.id));
    mockGetIssue.mockResolvedValue({
      labels: [{ name: "fresh-gitea", color: "abcdef" }],
    });

    await handleGiteaIssueLabeled(
      {
        action: "labeled",
        issue: { number: 7 },
        label: { name: "fresh-gitea", color: "abcdef" },
        repository: {
          owner: { login: "owner" },
          name: "repo",
          html_url: "https://gitea.example/owner/repo",
        },
      },
      integration.id,
    );

    expect(mockGetIssue).not.toHaveBeenCalled();
    const labels = await db.query.labelTable.findMany({
      where: eq(schema.labelTable.taskId, task.id),
    });
    expect(labels.map((label) => label.name).sort()).toEqual([
      "github-owned",
      "local-only",
      "shared-name",
      "stale-gitea",
    ]);
  });
});

describe("Gitea issue_labeled stale-event barrier", () => {
  it("does not reinsert a provider-deleted label from a stale labeled payload", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Webhook race",
        status: "to-do",
        number: 1,
      })
      .returning();
    const [giteaLabel] = await db
      .insert(schema.labelTable)
      .values({
        name: "webhook-race",
        color: "#123456",
        workspaceId: member.workspace.id,
        taskId: task?.id,
        source: "gitea",
      })
      .returning();
    if (!task || !giteaLabel) throw new Error("Failed to seed fixtures");

    const lockKey = `${member.workspace.id}:${normalizeLabelIdentity(giteaLabel.name)}`;
    const blocker = await getDatabasePool().connect();
    let lockHeld = false;
    let loaderCalledAfterDelete = false;

    try {
      await blocker.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        WORKSPACE_LABEL_LOCK_NAMESPACE,
        lockKey,
      ]);
      lockHeld = true;

      const reconcilePromise = reconcileGiteaIssueLabels(
        task.id,
        member.workspace.id,
        [giteaLabel.name],
        async () => {
          const current = await db.query.labelTable.findFirst({
            where: eq(schema.labelTable.id, giteaLabel.id),
          });
          loaderCalledAfterDelete = current === undefined;
          return [];
        },
      );
      await waitForBlockedLabelMutations(1);

      await db
        .delete(schema.labelTable)
        .where(eq(schema.labelTable.id, giteaLabel.id));
      await waitForBlockedLabelMutations(1);

      await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        WORKSPACE_LABEL_LOCK_NAMESPACE,
        lockKey,
      ]);
      lockHeld = false;

      await withTimeout(reconcilePromise, 10_000);

      expect(loaderCalledAfterDelete).toBe(true);
      const taskLabels = await db.query.labelTable.findMany({
        where: eq(schema.labelTable.taskId, task.id),
      });
      expect(taskLabels.some((label) => label.name === giteaLabel.name)).toBe(
        false,
      );
    } finally {
      if (lockHeld) {
        await blocker.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          WORKSPACE_LABEL_LOCK_NAMESPACE,
          lockKey,
        ]);
      }
      blocker.release();
    }
  }, 20_000);
});
