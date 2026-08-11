import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockListLabels = vi.fn();
const mockRemoveLabelFromIssue = vi.fn();
const mockCreateGiteaClient = vi.fn();
const mockGetIssue = vi.fn();
const mockAddLabelsToIssue = vi.fn();
const mockCreateLabel = vi.fn();

vi.mock("../../../../apps/api/src/database", () => ({
  default: {
    query: {
      externalLinkTable: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock(
  "../../../../apps/api/src/plugins/gitea/utils/gitea-api",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../apps/api/src/plugins/gitea/utils/gitea-api")
      >();
    return {
      ...actual,
      createGiteaClient: (...args: unknown[]) => {
        mockCreateGiteaClient(...args);
        return {
          listLabels: (...args: unknown[]) => mockListLabels(...args),
          createLabel: (...args: unknown[]) => mockCreateLabel(...args),
          getIssue: (...args: unknown[]) => mockGetIssue(...args),
          addLabelsToIssue: (...args: unknown[]) =>
            mockAddLabelsToIssue(...args),
          removeLabelFromIssue: (...args: unknown[]) =>
            mockRemoveLabelFromIssue(...args),
        };
      },
    };
  },
);

import { GiteaApiError } from "../../../../apps/api/src/plugins/gitea/utils/gitea-api";
import {
  removeLabelFromGitea,
  syncLabelToGitea,
} from "../../../../apps/api/src/plugins/gitea/utils/sync-label-to-gitea";

describe("removeLabelFromGitea", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListLabels.mockResolvedValue([]);
    mockRemoveLabelFromIssue.mockResolvedValue(undefined);
    mockGetIssue.mockResolvedValue({ labels: [{ id: 7, name: "bug" }] });
    mockFindMany.mockResolvedValue([
      {
        id: "link-1",
        resourceType: "issue",
        externalId: "12",
        integration: {
          type: "gitea",
          config: JSON.stringify({
            accessToken: "token",
            baseUrl: "https://gitea.example",
            repositoryOwner: "owner",
            repositoryName: "repo",
          }),
        },
      },
    ]);
  });

  it.each([
    ["accessToken", ["token"]],
    ["baseUrl", { url: "https://gitea.example" }],
    ["repositoryOwner", 42],
    ["repositoryName", ["repo"]],
  ])(
    "rejects a non-string %s before creating a client",
    async (field, value) => {
      mockFindMany.mockResolvedValue([
        {
          resourceType: "issue",
          externalId: "12",
          integration: {
            type: "gitea",
            config: JSON.stringify({
              accessToken: "token",
              baseUrl: "https://gitea.example",
              repositoryOwner: "owner",
              repositoryName: "repo",
              [field]: value,
            }),
          },
        },
      ]);

      await expect(syncLabelToGitea("task-1", "bug", "red")).rejects.toThrow(
        "incomplete",
      );
      expect(mockCreateGiteaClient).not.toHaveBeenCalled();
      expect(mockListLabels).not.toHaveBeenCalled();
    },
  );

  it("processes applicable attach links sequentially and propagates failure", async () => {
    const config = JSON.stringify({
      accessToken: "token",
      baseUrl: "https://gitea.example",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });
    mockFindMany.mockResolvedValue([
      {
        resourceType: "issue",
        externalId: "12",
        integration: { type: "gitea", config },
      },
      {
        resourceType: "issue",
        externalId: "13",
        integration: { type: "gitea", config },
      },
    ]);
    mockListLabels.mockResolvedValue([{ id: 7, name: "bug" }]);
    mockGetIssue.mockRejectedValueOnce(new Error("provider down"));

    await expect(syncLabelToGitea("task-1", "bug", "red")).rejects.toThrow(
      "provider down",
    );
    expect(mockGetIssue).toHaveBeenCalledTimes(1);
  });

  it("continues to later attach links after an idempotent existing label", async () => {
    const config = JSON.stringify({
      accessToken: "token",
      baseUrl: "https://gitea.example",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });
    mockFindMany.mockResolvedValue([
      {
        resourceType: "issue",
        externalId: "12",
        integration: { type: "gitea", config },
      },
      {
        resourceType: "issue",
        externalId: "13",
        integration: { type: "gitea", config },
      },
    ]);
    mockListLabels.mockResolvedValue([{ id: 7, name: "bug" }]);
    mockGetIssue
      .mockResolvedValueOnce({ labels: [{ id: 7, name: "bug" }] })
      .mockResolvedValueOnce({ labels: [] });

    await syncLabelToGitea("task-1", "bug", "red");
    expect(mockGetIssue).toHaveBeenCalledTimes(2);
    expect(mockAddLabelsToIssue).toHaveBeenCalledOnce();
    expect(mockAddLabelsToIssue).toHaveBeenCalledWith("owner", "repo", 13, [7]);
  });

  it("treats an already-missing provider label as idempotent success", async () => {
    mockListLabels.mockResolvedValue([]);

    await expect(
      removeLabelFromGitea("task-1", "bug"),
    ).resolves.toBeUndefined();
    expect(mockRemoveLabelFromIssue).not.toHaveBeenCalled();
  });

  it("treats a removal race returning 404 as idempotent success", async () => {
    mockListLabels.mockResolvedValue([{ id: 7, name: "bug" }]);
    mockRemoveLabelFromIssue.mockRejectedValue(
      new GiteaApiError("missing", 404, "HTTP_ERROR"),
    );

    await expect(
      removeLabelFromGitea("task-1", "bug"),
    ).resolves.toBeUndefined();
  });

  it("propagates provider failures", async () => {
    mockListLabels.mockResolvedValue([{ id: 7, name: "bug" }]);
    mockRemoveLabelFromIssue.mockRejectedValue(
      new GiteaApiError("unavailable", 503, "HTTP_ERROR"),
    );

    await expect(removeLabelFromGitea("task-1", "bug")).rejects.toThrow(
      "unavailable",
    );
  });

  it("removes from every applicable link and ignores other providers first", async () => {
    mockFindMany.mockResolvedValue([
      {
        resourceType: "issue",
        externalId: "1",
        integration: { type: "github", config: "{}" },
      },
      ...[12, 13].map((issue) => ({
        id: `link-${issue}`,
        resourceType: "issue",
        externalId: String(issue),
        integration: {
          type: "gitea",
          config: JSON.stringify({
            accessToken: "token",
            baseUrl: "https://gitea.example",
            repositoryOwner: "owner",
            repositoryName: "repo",
          }),
        },
      })),
    ]);
    mockListLabels.mockResolvedValue([{ id: 7, name: "bug" }]);

    await removeLabelFromGitea("task-1", "bug");
    expect(mockRemoveLabelFromIssue).toHaveBeenCalledTimes(2);
  });

  it("fails closed for malformed or incomplete applicable config", async () => {
    mockFindMany.mockResolvedValue([
      {
        resourceType: "issue",
        externalId: "12",
        integration: { type: "gitea", config: "{" },
      },
    ]);
    await expect(removeLabelFromGitea("task-1", "bug")).rejects.toThrow(
      "malformed",
    );

    mockFindMany.mockResolvedValue([
      {
        resourceType: "issue",
        externalId: "12",
        integration: {
          type: "gitea",
          config: JSON.stringify({ baseUrl: "https://gitea.example" }),
        },
      },
    ]);
    await expect(removeLabelFromGitea("task-1", "bug")).rejects.toThrow(
      "incomplete",
    );
    expect(mockRemoveLabelFromIssue).not.toHaveBeenCalled();
  });
});
