import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockGetInstallationOctokit = vi.fn();
const mockRemoveLabel = vi.fn();

vi.mock("../../../../apps/api/src/database", () => ({
  default: {
    query: {
      externalLinkTable: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock("../../../../apps/api/src/plugins/github/utils/github-app", () => ({
  getInstallationOctokit: (...args: unknown[]) =>
    mockGetInstallationOctokit(...args),
}));

vi.mock("../../../../apps/api/src/plugins/github/utils/labels", () => ({
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
}));

import { removeLabelFromGitHub } from "../../../../apps/api/src/plugins/github/utils/sync-label-to-github";

function githubLink(id: string, externalId: string, config: unknown) {
  return {
    id,
    resourceType: "issue",
    externalId,
    integration: { type: "github", config: JSON.stringify(config) },
  };
}

describe("removeLabelFromGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue({ rest: { issues: {} } });
    mockRemoveLabel.mockResolvedValue(undefined);
  });

  it("ignores a Gitea link before the applicable GitHub link", async () => {
    mockFindMany.mockResolvedValue([
      {
        resourceType: "issue",
        externalId: "3",
        integration: { type: "gitea", config: "{}" },
      },
      githubLink("github-1", "12", {
        repositoryOwner: "Owner",
        repositoryName: "Repo",
        installationId: 42,
      }),
    ]);

    await removeLabelFromGitHub("task-1", "bug");
    expect(mockRemoveLabel).toHaveBeenCalledOnce();
    expect(mockRemoveLabel).toHaveBeenCalledWith(
      expect.anything(),
      "Owner",
      "Repo",
      12,
      "bug",
    );
  });

  it("removes the label from every applicable issue link", async () => {
    mockFindMany.mockResolvedValue([
      githubLink("github-1", "12", {
        repositoryOwner: "Owner",
        repositoryName: "Repo",
        installationId: 42,
      }),
      githubLink("github-2", "19", {
        repositoryOwner: "Other",
        repositoryName: "Second",
        installationId: 84,
      }),
    ]);

    await removeLabelFromGitHub("task-1", "bug");
    expect(mockRemoveLabel).toHaveBeenCalledTimes(2);
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(2);
  });

  it("does not start a later applicable mutation after the first fails", async () => {
    mockFindMany.mockResolvedValue([
      githubLink("github-1", "12", {
        repositoryOwner: "Owner",
        repositoryName: "Repo",
        installationId: 42,
      }),
      githubLink("github-2", "19", {
        repositoryOwner: "Other",
        repositoryName: "Second",
        installationId: 84,
      }),
    ]);
    mockRemoveLabel.mockRejectedValueOnce(new Error("provider down"));

    await expect(removeLabelFromGitHub("task-1", "bug")).rejects.toThrow(
      "provider down",
    );
    expect(mockRemoveLabel).toHaveBeenCalledTimes(1);
  });

  it("fails closed for malformed config", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "github-1",
        resourceType: "issue",
        externalId: "12",
        integration: { type: "github", config: "{" },
      },
    ]);
    await expect(removeLabelFromGitHub("task-1", "bug")).rejects.toThrow(
      "malformed",
    );
    expect(mockRemoveLabel).not.toHaveBeenCalled();
  });

  it("fails closed when credentials or a client are missing", async () => {
    mockFindMany.mockResolvedValue([
      githubLink("github-1", "12", {
        repositoryOwner: "Owner",
        repositoryName: "Repo",
      }),
    ]);
    await expect(removeLabelFromGitHub("task-1", "bug")).rejects.toThrow(
      "incomplete",
    );

    mockFindMany.mockResolvedValue([
      githubLink("github-1", "12", {
        repositoryOwner: "Owner",
        repositoryName: "Repo",
        installationId: 42,
      }),
    ]);
    mockGetInstallationOctokit.mockResolvedValue(undefined);
    await expect(removeLabelFromGitHub("task-1", "bug")).rejects.toThrow(
      "could not be created",
    );
  });
});
