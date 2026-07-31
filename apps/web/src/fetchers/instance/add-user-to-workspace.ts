import { client } from "@kaneo/libs";

export type AddUserToWorkspaceInput = {
  userId: string;
  workspaceId: string;
  role: string;
};

export default async function addUserToWorkspace(
  input: AddUserToWorkspaceInput,
) {
  const response = await client.instance.users[":userId"].workspaces.$post({
    param: { userId: input.userId },
    json: { workspaceId: input.workspaceId, role: input.role },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
