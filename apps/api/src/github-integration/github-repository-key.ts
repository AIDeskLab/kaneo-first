export function normalizeGitHubRepositoryKey(
  repositoryOwner: string,
  repositoryName: string,
): string {
  const owner = repositoryOwner.trim().toLowerCase();
  const name = repositoryName.trim().toLowerCase();
  if (!owner || !name) {
    return "";
  }
  return `${owner}/${name}`;
}

export function githubRepositoryKeyFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }

  const { repositoryOwner, repositoryName } = config as {
    repositoryOwner?: unknown;
    repositoryName?: unknown;
  };

  if (
    typeof repositoryOwner !== "string" ||
    typeof repositoryName !== "string"
  ) {
    return null;
  }

  const key = normalizeGitHubRepositoryKey(repositoryOwner, repositoryName);
  return key || null;
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}
