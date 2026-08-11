import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  getRepoInstallation: vi.fn(async () => ({ data: { id: 42 } })),
}));

vi.mock("../../apps/api/src/plugins/github/utils/github-app", () => ({
  getGithubApp: () => ({
    octokit: {
      rest: { apps: { getRepoInstallation: githubMocks.getRepoInstallation } },
    },
  }),
}));

import db, { schema } from "../../apps/api/src/database";
import createGithubIntegration from "../../apps/api/src/github-integration/controllers/create-github-integration";
import { migrateGitHubIntegration } from "../../apps/api/src/plugins/github/migration";
import { findAllIntegrationsByRepo } from "../../apps/api/src/plugins/github/services/task-service";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function dropGithubActiveKeyCheck() {
  await db.execute(
    sql`ALTER TABLE "integration" DROP CONSTRAINT IF EXISTS "integration_github_active_requires_key_check"`,
  );
}

async function ensureLegacyGithubIntegrationTable() {
  if (await tableExists("github_integration")) {
    return;
  }

  await db.execute(sql`
    CREATE TABLE "github_integration" (
      "id" text PRIMARY KEY NOT NULL,
      "project_id" text NOT NULL UNIQUE REFERENCES "project"("id") ON DELETE cascade ON UPDATE cascade,
      "repository_owner" text NOT NULL,
      "repository_name" text NOT NULL,
      "installation_id" integer,
      "is_active" boolean DEFAULT true,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `);
}

async function resetForLegacyJsMigration() {
  await ensureLegacyGithubIntegrationTable();
  await resetTestDatabase();
}

async function runLegacyGithubBindingRepair() {
  const migration = await readFile(
    new URL("../../apps/api/drizzle/0040_needy_ultimatum.sql", import.meta.url),
    "utf8",
  );
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.length > 0 &&
        !statement.startsWith("ALTER TABLE") &&
        !statement.startsWith("CREATE UNIQUE INDEX"),
    );

  await db.execute(
    sql`DROP INDEX IF EXISTS "integration_github_repository_key_active_unique"`,
  );
  await db.execute(
    sql`ALTER TABLE "integration" DROP CONSTRAINT IF EXISTS "integration_github_active_requires_key_check"`,
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  await db.execute(
    sql`CREATE UNIQUE INDEX "integration_github_repository_key_active_unique" ON "integration" USING btree ("github_repository_key") WHERE "integration"."type" = 'github' and "integration"."is_active" = true and "integration"."github_repository_key" is not null`,
  );
  await db.execute(
    sql`ALTER TABLE "integration" ADD CONSTRAINT "integration_github_active_requires_key_check" CHECK ("integration"."type" <> 'github' OR "integration"."is_active" = false OR "integration"."github_repository_key" IS NOT NULL)`,
  );
}

async function tableExists(tableName: string) {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = ${tableName}
    );
  `);
  return (result.rows[0] as { exists: boolean }).exists === true;
}

describe("GitHub binding integrity migration repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deactivates case-equivalent cross-workspace duplicates without deleting rows or links", async () => {
    await resetForLegacyJsMigration();
    const firstWorkspace = await createWorkspaceMember();
    const secondWorkspace = await createWorkspaceMember();
    const firstProject = await createProjectFixture({
      workspaceId: firstWorkspace.workspace.id,
    });
    const secondProject = await createProjectFixture({
      workspaceId: secondWorkspace.workspace.id,
    });

    await dropGithubActiveKeyCheck();

    const [firstIntegration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: firstProject.project.id,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "Octo-Org",
          repositoryName: "Hello-World",
        }),
        isActive: true,
      })
      .returning();
    const [secondIntegration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: secondProject.project.id,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "octo-org",
          repositoryName: "hello-world",
        }),
        isActive: true,
      })
      .returning();
    if (!firstIntegration || !secondIntegration) {
      throw new Error("Failed to seed duplicate integrations");
    }

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: firstProject.project.id,
        title: "Linked issue",
        status: "to-do",
        number: 1,
      })
      .returning();
    if (!task) throw new Error("Failed to seed task");
    await db.insert(schema.externalLinkTable).values({
      taskId: task.id,
      integrationId: firstIntegration.id,
      resourceType: "issue",
      externalId: "42",
      url: "https://github.com/octo-org/hello-world/issues/42",
    });

    await runLegacyGithubBindingRepair();

    const integrations = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });
    expect(integrations).toHaveLength(2);
    expect(integrations.every((row) => row.isActive === false)).toBe(true);
    expect(integrations.every((row) => row.githubRepositoryKey === null)).toBe(
      true,
    );
    await expect(
      db.query.externalLinkTable.findMany({
        where: eq(schema.externalLinkTable.integrationId, firstIntegration.id),
      }),
    ).resolves.toHaveLength(1);
    await expect(
      findAllIntegrationsByRepo("octo-org", "hello-world"),
    ).resolves.toEqual([]);
  });

  it("keeps a unique valid binding active and populated after repair", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await dropGithubActiveKeyCheck();
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "solo-org",
          repositoryName: "repo",
        }),
        isActive: true,
      })
      .returning();
    if (!integration) throw new Error("Failed to seed integration");

    await runLegacyGithubBindingRepair();

    const repaired = await db.query.integrationTable.findFirst({
      where: eq(schema.integrationTable.id, integration.id),
    });
    expect(repaired).toMatchObject({
      isActive: true,
      githubRepositoryKey: "solo-org/repo",
    });
    await expect(
      findAllIntegrationsByRepo("SOLO-ORG", "repo"),
    ).resolves.toEqual([expect.objectContaining({ id: integration.id })]);
  });

  it("deactivates malformed active GitHub configuration during repair", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await dropGithubActiveKeyCheck();
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "github",
        config: "{not-json",
        isActive: true,
      })
      .returning();
    if (!integration) throw new Error("Failed to seed integration");

    await runLegacyGithubBindingRepair();

    await expect(
      db.query.integrationTable.findFirst({
        where: eq(schema.integrationTable.id, integration.id),
      }),
    ).resolves.toMatchObject({
      isActive: false,
      githubRepositoryKey: null,
    });
  });

  it("rejects concurrent case-equivalent activation after repair", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const first = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const second = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await createGithubIntegration({
      projectId: first.project.id,
      repositoryOwner: "bound-org",
      repositoryName: "repo",
    });

    await expect(
      createGithubIntegration({
        projectId: second.project.id,
        repositoryOwner: "BOUND-ORG",
        repositoryName: "REPO",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const active = await db.query.integrationTable.findMany({
      where: and(
        eq(schema.integrationTable.type, "github"),
        eq(schema.integrationTable.isActive, true),
      ),
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.githubRepositoryKey).toBe("bound-org/repo");
  });
}, 30_000);

describe("GitHub legacy JS migration after SQL 0040", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates a unique valid legacy binding with repository key and routing", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "solo-org",
      repositoryName: "repo",
      isActive: true,
    });

    await migrateGitHubIntegration();

    const integration = await db.query.integrationTable.findFirst({
      where: and(
        eq(schema.integrationTable.projectId, project.id),
        eq(schema.integrationTable.type, "github"),
      ),
    });
    expect(integration).toMatchObject({
      isActive: true,
      githubRepositoryKey: "solo-org/repo",
    });
    await expect(
      findAllIntegrationsByRepo("SOLO-ORG", "repo"),
    ).resolves.toEqual([expect.objectContaining({ id: integration?.id })]);
    await expect(tableExists("github_integration")).resolves.toBe(false);
  });

  it("deactivates case-equivalent legacy duplicates without deleting rows or links", async () => {
    await resetForLegacyJsMigration();
    const firstWorkspace = await createWorkspaceMember();
    const secondWorkspace = await createWorkspaceMember();
    const firstProject = await createProjectFixture({
      workspaceId: firstWorkspace.workspace.id,
    });
    const secondProject = await createProjectFixture({
      workspaceId: secondWorkspace.workspace.id,
    });

    const [firstOld] = await db
      .insert(schema.githubIntegrationTable)
      .values({
        projectId: firstProject.project.id,
        repositoryOwner: "Octo-Org",
        repositoryName: "Hello-World",
        isActive: true,
      })
      .returning();
    const [secondOld] = await db
      .insert(schema.githubIntegrationTable)
      .values({
        projectId: secondProject.project.id,
        repositoryOwner: "octo-org",
        repositoryName: "hello-world",
        isActive: true,
      })
      .returning();
    if (!firstOld || !secondOld) {
      throw new Error("Failed to seed legacy integrations");
    }

    await migrateGitHubIntegration();

    const integrations = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });
    expect(integrations).toHaveLength(2);
    expect(integrations.every((row) => row.isActive === false)).toBe(true);
    expect(integrations.every((row) => row.githubRepositoryKey === null)).toBe(
      true,
    );
    await expect(
      findAllIntegrationsByRepo("octo-org", "hello-world"),
    ).resolves.toEqual([]);
  });

  it("deactivates malformed legacy bindings during JS migration", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "   ",
      repositoryName: "",
      isActive: true,
    });

    await migrateGitHubIntegration();

    const integration = await db.query.integrationTable.findFirst({
      where: and(
        eq(schema.integrationTable.projectId, project.id),
        eq(schema.integrationTable.type, "github"),
      ),
    });
    expect(integration).toMatchObject({
      isActive: false,
      githubRepositoryKey: null,
    });
  });

  it("deactivates all bindings when legacy migration collides with an existing generic integration", async () => {
    await resetForLegacyJsMigration();
    const firstWorkspace = await createWorkspaceMember();
    const secondWorkspace = await createWorkspaceMember();
    const firstProject = await createProjectFixture({
      workspaceId: firstWorkspace.workspace.id,
    });
    const secondProject = await createProjectFixture({
      workspaceId: secondWorkspace.workspace.id,
    });

    const [existingIntegration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: firstProject.project.id,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "shared-org",
          repositoryName: "repo",
        }),
        isActive: true,
        githubRepositoryKey: "shared-org/repo",
      })
      .returning();
    if (!existingIntegration) {
      throw new Error("Failed to seed existing integration");
    }

    await db.insert(schema.githubIntegrationTable).values({
      projectId: secondProject.project.id,
      repositoryOwner: "SHARED-ORG",
      repositoryName: "REPO",
      isActive: true,
    });

    await migrateGitHubIntegration();

    const integrations = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });
    expect(integrations).toHaveLength(2);
    expect(integrations.every((row) => row.isActive === false)).toBe(true);
    expect(integrations.every((row) => row.githubRepositoryKey === null)).toBe(
      true,
    );
    await expect(
      findAllIntegrationsByRepo("shared-org", "repo"),
    ).resolves.toEqual([]);
  });

  it("preserves migrated integration rows and external links without deleting data", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [oldIntegration] = await db
      .insert(schema.githubIntegrationTable)
      .values({
        projectId: project.id,
        repositoryOwner: "linked-org",
        repositoryName: "repo",
        isActive: true,
      })
      .returning();
    if (!oldIntegration) {
      throw new Error("Failed to seed legacy integration");
    }

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Linked issue",
        status: "to-do",
        number: 1,
        description:
          "Created from GitHub issue: https://github.com/linked-org/repo/issues/7",
      })
      .returning();
    if (!task) {
      throw new Error("Failed to seed task");
    }

    await migrateGitHubIntegration();

    const integrations = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });
    expect(integrations).toHaveLength(1);
    const [integration] = integrations;
    if (!integration) {
      throw new Error("Expected migrated integration");
    }

    const links = await db.query.externalLinkTable.findMany({
      where: eq(schema.externalLinkTable.integrationId, integration.id),
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      taskId: task.id,
      externalId: "7",
    });
  });

  it("is idempotent when rerun after the legacy table is dropped", async () => {
    await resetForLegacyJsMigration();
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "solo-org",
      repositoryName: "repo",
      isActive: true,
    });

    await migrateGitHubIntegration();
    const afterFirst = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });

    await migrateGitHubIntegration();
    const afterSecond = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });

    expect(afterSecond).toEqual(afterFirst);
    await expect(tableExists("github_integration")).resolves.toBe(false);
  });
}, 30_000);
