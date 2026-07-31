import { client } from "@kaneo/libs";

export type UpdateUserStatusInput = {
  userId: string;
  banned: boolean;
  banReason?: string | null;
  banExpires?: string | null;
};

export default async function updateUserStatus(input: UpdateUserStatusInput) {
  const { userId, ...json } = input;
  const response = await client.instance.users[":userId"].status.$patch({
    param: { userId },
    json,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
