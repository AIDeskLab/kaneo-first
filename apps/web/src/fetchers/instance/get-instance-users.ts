import { client } from "@kaneo/libs";
import type { InstanceUsersResponse } from "@/types/instance-user";

export default async function getInstanceUsers(
  limit = 50,
  offset = 0,
): Promise<InstanceUsersResponse> {
  const response = await client.instance.users.$get({
    query: { limit: String(limit), offset: String(offset) },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<InstanceUsersResponse>;
}
