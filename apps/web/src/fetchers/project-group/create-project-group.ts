import { client } from "@kaneo/libs";

async function createProjectGroup(workspaceId: string, name: string) {
  const response = await client["project-group"].$post({
    query: { workspaceId },
    json: { name },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default createProjectGroup;
