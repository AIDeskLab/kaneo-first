import { client } from "@kaneo/libs";

export type RemoveUserFromWorkspaceInput = {
  userId: string;
  workspaceId: string;
};

export default async function removeUserFromWorkspace(
  input: RemoveUserFromWorkspaceInput,
) {
  const response = await client.instance.users[":userId"].workspaces[
    ":workspaceId"
  ].$delete({
    param: input,
  });
  if (!response.ok) throw new Error(await response.text());
  return;
}
