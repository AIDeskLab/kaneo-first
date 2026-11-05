import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const githubMocks = vi.hoisted(() => ({
  listRepositories: vi.fn(async () => ({
    repositories: [],
    installations: [],
    nextPage: null,
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

vi.mock(
  "../../apps/api/src/github-integration/controllers/list-user-repositories",
  () => ({ default: githubMocks.listRepositories }),
);
vi.mock(
  "../../apps/api/src/github-integration/controllers/verify-github-installation",
  () => ({ default: githubMocks.verifyInstallation }),
);

import { createApp } from "../../apps/api/src/index";
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
    app.request("/api/github-integration/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        repositoryOwner: "owner",
        repositoryName: "repository",
      }),
    }),
  ]);
}

describe("GitHub integration discovery scope", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  it("lets a workspace admin list repositories and still requires a connected GitHub account to verify", async () => {
    const actor = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: actor.workspace.id,
    });
    mockAuthenticatedSession(actor.user);
    const { app } = createApp();

    const [listed, verified] = await requestScopedEndpoints(app, project.id);
    expect(listed.status).toBe(200);
    expect(githubMocks.listRepositories).toHaveBeenCalledOnce();
    expect(verified.status).toBe(403);
    expect(githubMocks.verifyInstallation).not.toHaveBeenCalled();
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
