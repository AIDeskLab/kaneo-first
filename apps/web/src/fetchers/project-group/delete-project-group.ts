import { client } from "@kaneo/libs";

async function deleteProjectGroup(id: string) {
  const response = await client["project-group"][":id"].$delete({
    param: { id },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default deleteProjectGroup;
