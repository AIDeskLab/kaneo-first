import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/api/src/utils/assert-public-destination", () => ({
  fetchPublicDestination: (url: string, _label: string, init?: RequestInit) =>
    fetchMock(url, init),
}));

const { default: verifyGiteaAccess } = await import(
  "../../../apps/api/src/gitea-integration/controllers/verify-gitea-access"
);

function makeResponse(status: number, body: string | object = ""): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("verifyGiteaAccess — fetch integration", () => {
  it("returns success when the API returns a user and a writable repo", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200, { id: 1, login: "owner" }))
      .mockResolvedValueOnce(
        makeResponse(200, {
          name: "repo",
          owner: { login: "owner" },
          html_url: "https://gitea.example/owner/repo",
          private: false,
          permissions: { admin: true, push: true, pull: true },
        }),
      );

    const result = await verifyGiteaAccess({
      baseUrl: "https://gitea.example",
      accessToken: "token",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    expect(result).toEqual({
      isInstalled: true,
      hasRequiredPermissions: true,
      repositoryExists: true,
      repositoryPrivate: false,
      missingPermissions: [],
      message: "Token can access the repository.",
      failureReason: null,
    });
  });

  it("returns the 'not a Gitea instance' message when the response body is HTML, not JSON", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, "<html>Not Gitea</html>"));

    const result = await verifyGiteaAccess({
      baseUrl: "https://gitea.example",
      accessToken: "token",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    expect(result.isInstalled).toBe(false);
    expect(result.repositoryExists).toBe(false);
    expect(result.failureReason).toBe("not_a_gitea_instance");
    expect(result.message).toBe("The URL does not point to a Gitea instance.");
  });

  it("returns a redirect-specific message when the API responds with 308", async () => {
    fetchMock.mockResolvedValue(makeResponse(308, ""));

    const result = await verifyGiteaAccess({
      baseUrl: "http://gitea.example",
      accessToken: "token",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    expect(result.isInstalled).toBe(false);
    expect(result.failureReason).toBe("redirected");
    expect(result.message).toContain("redirected");
    expect(result.message).toContain("HTTP 308");
  });

  it("returns a redirect-specific message when the API responds with 301", async () => {
    fetchMock.mockResolvedValue(makeResponse(301, ""));

    const result = await verifyGiteaAccess({
      baseUrl: "http://gitea.example",
      accessToken: "token",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    expect(result.failureReason).toBe("redirected");
    expect(result.message).toContain("HTTP 301");
  });

  it("returns the repository-not-found message when getRepo responds with 404", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200, { id: 1, login: "owner" }))
      .mockResolvedValueOnce(makeResponse(404, "Not Found"));

    const result = await verifyGiteaAccess({
      baseUrl: "https://gitea.example",
      accessToken: "token",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    expect(result.isInstalled).toBe(false);
    expect(result.failureReason).toBe("repository_not_found");
    expect(result.message).toBe(
      "Repository not found or not accessible with this token.",
    );
  });

  it("returns the not-a-gitea-instance message when /user responds with 404", async () => {
    fetchMock.mockResolvedValue(makeResponse(404, "Not Found"));

    const result = await verifyGiteaAccess({
      baseUrl: "https://gitea.example",
      accessToken: "token",
      repositoryOwner: "owner",
      repositoryName: "repo",
    });

    expect(result.isInstalled).toBe(false);
    expect(result.failureReason).toBe("not_a_gitea_instance");
    expect(result.message).toBe("The URL does not point to a Gitea instance.");
  });
});
