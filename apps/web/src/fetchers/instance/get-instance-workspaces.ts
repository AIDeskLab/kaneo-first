import { client } from "@kaneo/libs";
import type { InstanceWorkspace } from "@/types/instance-user";

export default async function getInstanceWorkspaces(): Promise<
  InstanceWorkspace[]
> {
  const response = await client.instance.workspaces.$get();
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<InstanceWorkspace[]>;
}
