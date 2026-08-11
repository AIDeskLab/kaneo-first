import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();

vi.mock("../../apps/api/src/database", () => ({
  default: {
    query: {
      integrationTable: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

import { findAllIntegrationsByRepo } from "../../apps/api/src/plugins/github/services/task-service";

function integrationRow(id: string, config: Record<string, unknown>) {
  return {
    id,
    type: "github",
    isActive: true,
    githubRepositoryKey: "octo-org/hello-world",
    config: JSON.stringify(config),
    project: { id: `project-${id}` },
  };
}

describe("findAllIntegrationsByRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a single verified integration for a normalized repository key", async () => {
    mockFindMany.mockResolvedValueOnce([
      integrationRow("one", {
        repositoryOwner: "octo-org",
        repositoryName: "Hello-World",
      }),
    ]);

    await expect(
      findAllIntegrationsByRepo("OCTO-ORG", "hello-world"),
    ).resolves.toHaveLength(1);
  });

  it("fails closed when multiple active integrations share a repository key", async () => {
    mockFindMany.mockResolvedValueOnce([
      integrationRow("one", {
        repositoryOwner: "octo-org",
        repositoryName: "hello-world",
      }),
      integrationRow("two", {
        repositoryOwner: "octo-org",
        repositoryName: "hello-world",
      }),
    ]);

    await expect(
      findAllIntegrationsByRepo("octo-org", "hello-world"),
    ).resolves.toEqual([]);
  });

  it("fails closed when active config does not match the normalized key", async () => {
    mockFindMany.mockResolvedValueOnce([
      integrationRow("one", {
        repositoryOwner: "other-org",
        repositoryName: "hello-world",
      }),
    ]);

    await expect(
      findAllIntegrationsByRepo("octo-org", "hello-world"),
    ).resolves.toEqual([]);
  });

  it("fails closed for malformed active configuration", async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        id: "broken",
        type: "github",
        isActive: true,
        githubRepositoryKey: "octo-org/hello-world",
        config: "{not-json",
        project: { id: "project-broken" },
      },
    ]);

    await expect(
      findAllIntegrationsByRepo("octo-org", "hello-world"),
    ).resolves.toEqual([]);
  });

  it("returns no routing for blank repository identity", async () => {
    await expect(findAllIntegrationsByRepo(" ", " ")).resolves.toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
