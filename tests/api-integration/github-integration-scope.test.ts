import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  getRepoInstallation: vi.fn(async () => ({ data: { id: 42 } })),
  listRepositories: vi.fn(async () => ({
    repositories: [],
    installations: [],
  })),
  verifyInstallation: vi.fn(async () => ({
    isInstalled: true,
    hasRequiredPermissions: true,
    repositoryExists: true,
    repositoryPrivate: false,
    missingPermissions: [],
    message: "ok",
  })),
}));

vi.mock("../../apps/api/src/plugins/github/utils/github-app", () => ({
  getGithubApp: () => ({
    octokit: {
      rest: { apps: { getRepoInstallation: githubMocks.getRepoInstallation } },
    },
  }),
}));

vi.mock(
  "../../apps/api/src/github-integration/controllers/list-user-repositories",
  () => ({ default: githubMocks.listRepositories }),
);
vi.mock(
  "../../apps/api/src/github-integration/controllers/verify-github-installation",
  () => ({ default: githubMocks.verifyInstallation }),
);

import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { findAllIntegrationsByRepo } from "../../apps/api/src/plugins/github/services/task-service";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function requestScopedEndpoints(
  app: ReturnType<typeof createApp>["app"],
  projectId: string,
) {
  return Promise.all([
    app.request(`/api/github-integration/repositories/${projectId}`),
    app.request(`/api/github-integration/verify/${projectId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryOwner: "owner",
        repositoryName: "repository",
      }),
    }),
  ]);
}

function bindRepository(
  app: ReturnType<typeof createApp>["app"],
  projectId: string,
) {
  return app.request(`/api/github-integration/project/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryOwner: "other-tenant",
      repositoryName: "private",
    }),
  });
}

describe("GitHub integration discovery scope", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  it("allows an instance admin to inspect an admitted project", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const [instanceAdmin] = await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, actor.user.id))
      .returning();
    expect(instanceAdmin).toBeDefined();
    if (!instanceAdmin) throw new Error("Failed to promote instance admin");
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    mockAuthenticatedSession(instanceAdmin);
    const { app } = createApp();

    const responses = await requestScopedEndpoints(app, project.id);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(githubMocks.listRepositories).toHaveBeenCalledOnce();
    expect(githubMocks.verifyInstallation).toHaveBeenCalledOnce();
  });

  it("denies a workspace admin and returns no global repository metadata", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    githubMocks.listRepositories.mockResolvedValueOnce({
      repositories: [
        { id: 7, full_name: "other-tenant/private", private: true },
      ],
      installations: [],
    });
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();

    const responses = await requestScopedEndpoints(app, project.id);
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    const bodies = await Promise.all(
      responses.map((response) => response.text()),
    );
    expect(bodies.join(" ")).not.toContain("other-tenant/private");
    expect(githubMocks.listRepositories).not.toHaveBeenCalled();
    expect(githubMocks.verifyInstallation).not.toHaveBeenCalled();

    const binding = await bindRepository(app, project.id);
    expect(binding.status).toBe(403);
    expect(githubMocks.getRepoInstallation).not.toHaveBeenCalled();
    await expect(
      db.query.integrationTable.findFirst({
        where: eq(schema.integrationTable.projectId, project.id),
      }),
    ).resolves.toBeUndefined();
  });

  it("allows an instance admin to bind a repository", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const [instanceAdmin] = await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, actor.user.id))
      .returning();
    if (!instanceAdmin) throw new Error("Failed to promote instance admin");
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    mockAuthenticatedSession(instanceAdmin);
    const { app } = createApp();

    const response = await bindRepository(app, project.id);
    expect(response.status).toBe(200);
    expect(githubMocks.getRepoInstallation).toHaveBeenCalledOnce();
    await expect(
      db.query.integrationTable.findFirst({
        where: eq(schema.integrationTable.projectId, project.id),
      }),
    ).resolves.toMatchObject({ type: "github", isActive: true });
  });

  it("preserves provider casing and resolves mixed-case webhook repository identity", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const [instanceAdmin] = await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, actor.user.id))
      .returning();
    if (!instanceAdmin) throw new Error("Failed to promote instance admin");
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    mockAuthenticatedSession(instanceAdmin);
    const { app } = createApp();

    const response = await app.request(
      `/api/github-integration/project/${project.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: " octo-org ",
          repositoryName: " Hello-World ",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repositoryOwner: "octo-org",
      repositoryName: "Hello-World",
    });

    const stored = await db.query.integrationTable.findFirst({
      where: eq(schema.integrationTable.projectId, project.id),
    });
    expect(JSON.parse(stored?.config ?? "{}")).toMatchObject({
      repositoryOwner: "octo-org",
      repositoryName: "Hello-World",
    });
    await expect(
      findAllIntegrationsByRepo("OCTO-ORG", "hello-world"),
    ).resolves.toEqual([expect.objectContaining({ id: stored?.id })]);
  });

  it("serializes case-insensitive repository bindings across projects", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const [instanceAdmin] = await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, actor.user.id))
      .returning();
    if (!instanceAdmin) throw new Error("Failed to promote instance admin");
    const first = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    const second = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    mockAuthenticatedSession(instanceAdmin);
    const { app } = createApp();

    const responses = await Promise.all([
      bindRepository(app, first.project.id),
      app.request(`/api/github-integration/project/${second.project.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: "OTHER-TENANT",
          repositoryName: "PRIVATE",
        }),
      }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const integrations = await db.query.integrationTable.findMany({
      where: eq(schema.integrationTable.type, "github"),
    });
    expect(integrations).toHaveLength(1);
    expect(JSON.parse(integrations[0]?.config ?? "{}")).toMatchObject({
      repositoryOwner: "other-tenant",
      repositoryName: "private",
    });
  });

  it("denies members without workspace:manage_settings", async () => {
    const actor = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();

    const responses = await requestScopedEndpoints(app, project.id);
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(githubMocks.listRepositories).not.toHaveBeenCalled();
    expect(githubMocks.verifyInstallation).not.toHaveBeenCalled();
  });

  it("denies access to a project in another workspace", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const target = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: target.workspace.id,
    });
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();

    const responses = await requestScopedEndpoints(app, project.id);
    expect(responses.every((response) => response.status >= 400)).toBe(true);
    expect(githubMocks.listRepositories).not.toHaveBeenCalled();
    expect(githubMocks.verifyInstallation).not.toHaveBeenCalled();
  });
});
