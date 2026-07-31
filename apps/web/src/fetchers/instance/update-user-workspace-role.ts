import { client } from "@kaneo/libs";

export type UpdateUserWorkspaceRoleInput = {
  userId: string;
  workspaceId: string;
  role: string;
};

export default async function updateUserWorkspaceRole(
  input: UpdateUserWorkspaceRoleInput,
) {
  const response = await client.instance.users[":userId"].workspaces[
    ":workspaceId"
  ].$patch({
    param: { userId: input.userId, workspaceId: input.workspaceId },
    json: { role: input.role },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
