import { client } from "@kaneo/libs";

async function getProjectGroups(workspaceId: string) {
  if (!workspaceId) return;

  const response = await client["project-group"].$get({
    query: { workspaceId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default getProjectGroups;
