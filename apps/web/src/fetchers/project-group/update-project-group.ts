import { client } from "@kaneo/libs";

async function updateProjectGroup(id: string, name: string) {
  const response = await client["project-group"][":id"].$patch({
    param: { id },
    json: { name },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default updateProjectGroup;
